import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { asArray, asRecord, stringId, stringValue } from '../utils/json.js';
import {
  IdSchema,
  additiveAnnotations,
  registerClickUpTool,
  taskQuery,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60_000;

interface StagedUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

const FilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/\0]/.test(value), 'filename must not contain path separators.');

const LocalUploadSchema = z
  .object({
    file_path: z.string().trim().min(1),
    filename: FilenameSchema.optional(),
    mime_type: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const InlineUploadSchema = z
  .object({
    filename: FilenameSchema,
    content_base64: z.string().min(1).max(Math.ceil((MAX_TRANSFER_BYTES * 4) / 3) + 4),
    mime_type: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const UrlUploadSchema = z
  .object({
    url: z.url({ protocol: /^https$/ }),
    filename: FilenameSchema.optional(),
    mime_type: z.string().trim().min(1).max(255).optional(),
    auth_header: z.string().trim().min(1).max(8_192).optional(),
  })
  .strict();

const RequestAttachmentUploadSchema = z.union([
  LocalUploadSchema,
  InlineUploadSchema,
  UrlUploadSchema,
]);

const AttachTaskFileSchema = z
  .object({
    task_id: IdSchema,
    upload_id: z.uuid(),
    custom_task_ids: z.boolean().optional().default(false),
    workspace_id: IdSchema.optional(),
  })
  .strict();

const DownloadTaskAttachmentSchema = z
  .object({
    task_id: IdSchema,
    attachment_id: IdSchema,
    workspace_id: IdSchema.optional(),
    destination_path: z.string().trim().min(1).optional(),
    overwrite: z.boolean().optional().default(false),
    max_bytes: z.number().int().min(1).max(MAX_TRANSFER_BYTES).optional().default(MAX_TRANSFER_BYTES),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.overwrite && input.destination_path === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['overwrite'],
        message: 'overwrite is only valid when destination_path is provided.',
      });
    }
  });

function uploadCacheKey(uploadId: string): string {
  return `attachment-upload:${uploadId}`;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length === 0 || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ToolFailure('ATTACHMENT_BASE64_INVALID', 'content_base64 is not valid base64.', false);
  }
  const bytes = Buffer.from(normalized, 'base64');
  const roundTrip = bytes.toString('base64').replace(/=+$/, '');
  if (roundTrip !== normalized.replace(/=+$/, '')) {
    throw new ToolFailure('ATTACHMENT_BASE64_INVALID', 'content_base64 is not valid base64.', false);
  }
  return bytes;
}

function assertTransferSize(size: number): void {
  if (size > MAX_TRANSFER_BYTES) {
    throw new ToolFailure(
      'ATTACHMENT_TOO_LARGE',
      `This MCP accepts staged files up to ${MAX_TRANSFER_BYTES} bytes.`,
      false,
      { max_bytes: MAX_TRANSFER_BYTES, supplied_bytes: size },
    );
  }
}

async function prepareUpload(
  input: z.output<typeof RequestAttachmentUploadSchema>,
  dependencies: ToolDependencies,
): Promise<StagedUpload> {
  if ('file_path' in input) {
    const details = await stat(input.file_path);
    if (!details.isFile()) {
      throw new ToolFailure('ATTACHMENT_NOT_FILE', 'file_path must identify a regular file.', false);
    }
    assertTransferSize(details.size);
    const bytes = await readFile(input.file_path);
    assertTransferSize(bytes.byteLength);
    return {
      filename: FilenameSchema.parse(input.filename ?? basename(input.file_path)),
      mimeType: input.mime_type ?? 'application/octet-stream',
      bytes,
    };
  }

  if ('content_base64' in input) {
    const bytes = decodeBase64(input.content_base64);
    assertTransferSize(bytes.byteLength);
    return {
      filename: input.filename,
      mimeType: input.mime_type ?? 'application/octet-stream',
      bytes,
    };
  }

  const downloaded = await dependencies.client.download(
    input.url,
    MAX_TRANSFER_BYTES,
    input.auth_header,
  );
  const urlPath = new URL(downloaded.finalUrl).pathname;
  const pathFilename = basename(decodeURIComponent(urlPath));
  const filename = FilenameSchema.parse((input.filename ?? pathFilename) || 'attachment');
  return {
    filename,
    mimeType: input.mime_type ?? downloaded.contentType ?? 'application/octet-stream',
    bytes: downloaded.bytes,
  };
}

async function findAttachment(
  dependencies: ToolDependencies,
  workspaceId: string,
  taskId: string,
  attachmentId: string,
): Promise<Record<string, unknown>> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = asRecord(
      await dependencies.client.request({
        version: 'v3',
        path: `/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(taskId)}/attachments`,
        query: { cursor, limit: 100 },
      }),
      'task attachments response',
    );
    const attachment = asArray(response.data).find((candidate) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      return stringId((candidate as Record<string, unknown>).id) === attachmentId;
    });
    if (attachment !== undefined) return attachment as Record<string, unknown>;
    cursor = stringValue(response.next_cursor);
    if (cursor === undefined || cursor.length === 0) break;
  }
  throw new ToolFailure(
    'ATTACHMENT_NOT_FOUND',
    `Attachment ${attachmentId} was not found on Task ${taskId}.`,
    false,
  );
}

export const ATTACHMENT_TOOL_NAMES = [
  'request_attachment_upload',
  'attach_task_file',
  'download_task_attachment',
] as const;

export function registerAttachmentTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'request_attachment_upload',
    title: 'Request Attachment Upload',
    description:
      'Stage a caller-approved local file, base64 payload, or HTTPS URL for a short-lived task attachment upload.',
    inputSchema: RequestAttachmentUploadSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const upload = await prepareUpload(input, dependencies);
      const uploadId = randomUUID();
      dependencies.cache.set(uploadCacheKey(uploadId), upload, UPLOAD_TTL_MS);
      return {
        data: {
          upload_id: uploadId,
          filename: upload.filename,
          mime_type: upload.mimeType,
          size_bytes: upload.bytes.byteLength,
          expires_in_seconds: UPLOAD_TTL_MS / 1_000,
        },
        summary: `Staged ${upload.filename} for attachment upload.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'attach_task_file',
    title: 'Attach File to Task',
    description: 'Consume a staged upload and attach it to a ClickUp Task using multipart form data.',
    inputSchema: AttachTaskFileSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const key = uploadCacheKey(input.upload_id);
      const upload = dependencies.cache.get<StagedUpload>(key);
      if (upload === undefined) {
        throw new ToolFailure(
          'ATTACHMENT_UPLOAD_EXPIRED',
          'The staged upload does not exist or has expired. Request a new upload.',
          false,
        );
      }
      const formData = new FormData();
      const blobBytes = Uint8Array.from(upload.bytes);
      formData.append(
        'attachment[0]',
        new Blob([blobBytes.buffer], { type: upload.mimeType }),
        upload.filename,
      );
      const response = await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/attachment`,
        method: 'POST',
        query: taskQuery(dependencies, input),
        formData,
      });
      dependencies.cache.deletePrefix(key);
      return {
        data: { task_id: input.task_id, filename: upload.filename, response },
        summary: `Attached ${upload.filename} to Task ${input.task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'download_task_attachment',
    title: 'Download Task Attachment',
    description: 'Resolve a task attachment and return its signed URL or save it to an explicit local destination.',
    inputSchema: DownloadTaskAttachmentSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const attachment = await findAttachment(
        dependencies,
        workspaceId,
        input.task_id,
        input.attachment_id,
      );
      const url = stringValue(attachment.url);
      if (url === undefined) {
        throw new ToolFailure(
          'ATTACHMENT_URL_MISSING',
          'ClickUp did not return a download URL for the attachment.',
          true,
        );
      }
      if (input.destination_path === undefined) {
        return {
          data: { attachment, download_url: url },
          summary: `Resolved the download URL for attachment ${input.attachment_id}.`,
        };
      }

      const downloaded = await dependencies.client.download(url, input.max_bytes);
      try {
        await writeFile(input.destination_path, downloaded.bytes, {
          flag: input.overwrite ? 'w' : 'wx',
        });
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          throw new ToolFailure(
            'ATTACHMENT_DESTINATION_EXISTS',
            'The destination already exists; set overwrite=true to replace it.',
            false,
            { destination_path: input.destination_path },
          );
        }
        throw error;
      }
      return {
        data: {
          attachment,
          destination_path: input.destination_path,
          size_bytes: downloaded.contentLength,
          ...(downloaded.contentType === undefined ? {} : { mime_type: downloaded.contentType }),
        },
        summary: `Downloaded attachment ${input.attachment_id} to ${input.destination_path}.`,
      };
    },
  });
}
