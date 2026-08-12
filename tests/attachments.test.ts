import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest, DownloadedFile } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerAttachmentTools } from '../src/tools/attachments.js';
import type { ToolDependencies } from '../src/tools/types.js';
import { MemoryCache } from '../src/utils/cache.js';

type ToolResult = {
  isError?: boolean;
  structuredContent?: { data?: Record<string, unknown>; error?: { code?: string } };
};
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function harness(responses: unknown[]) {
  const handlers = new Map<string, ToolHandler>();
  const request = vi.fn<(request: ClickUpRequest) => Promise<unknown>>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  const download = vi.fn<(url: string, maxBytes: number) => Promise<DownloadedFile>>();
  const requireWorkspaceId = vi.fn((explicit?: string) => explicit ?? '42');
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerAttachmentTools(server, {
    client: { request, download, requireWorkspaceId },
    logger: noopLogger,
    cache: new MemoryCache(),
  } as unknown as ToolDependencies);
  const call = async (name: string, input: Record<string, unknown>) => handlers.get(name)!(input);
  return { call, request, download };
}

describe('attachment tools', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
    );
  });

  it('stages base64 content and uploads it as multipart form data', async () => {
    const { call, request } = harness([{ id: 'attachment-1' }]);
    const staged = await call('request_attachment_upload', {
      filename: 'hello.txt',
      mime_type: 'text/plain',
      content_base64: Buffer.from('hello').toString('base64'),
    });
    const uploadId = staged.structuredContent?.data?.upload_id;
    expect(uploadId).toBeTypeOf('string');

    await call('attach_task_file', { task_id: 'task/1', upload_id: uploadId });

    const uploadRequest = request.mock.calls[0]?.[0];
    expect(uploadRequest).toMatchObject({
      path: '/task/task%2F1/attachment',
      method: 'POST',
      query: {},
    });
    const file = uploadRequest?.formData?.get('attachment[0]');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('hello.txt');
    await expect((file as File).text()).resolves.toBe('hello');

    const reused = await call('attach_task_file', { task_id: 'task/1', upload_id: uploadId });
    expect(reused).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'ATTACHMENT_UPLOAD_EXPIRED' } },
    });
  });

  it('stages an HTTPS URL with optional authorization before uploading it', async () => {
    const { call, request, download } = harness([{ id: 'attachment-1' }]);
    download.mockResolvedValue({
      bytes: Buffer.from('remote contents'),
      contentLength: 15,
      contentType: 'text/plain',
      finalUrl: 'https://files.example.com/generated/report.txt',
    });

    const staged = await call('request_attachment_upload', {
      url: 'https://files.example.com/download/123',
      auth_header: 'Bearer secret',
    });
    const uploadId = staged.structuredContent?.data?.upload_id;
    await call('attach_task_file', { task_id: 'task-1', upload_id: uploadId });

    expect(download).toHaveBeenCalledWith(
      'https://files.example.com/download/123',
      25 * 1024 * 1024,
      'Bearer secret',
    );
    const uploadRequest = request.mock.calls[0]?.[0];
    const file = uploadRequest?.formData?.get('attachment[0]');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('report.txt');
    await expect((file as File).text()).resolves.toBe('remote contents');
  });

  it('resolves a signed attachment URL from the v3 paginated endpoint', async () => {
    const { call, request } = harness([
      {
        data: [{ id: 'attachment-1', title: 'report.pdf', url: 'https://attachments.clickup.com/report' }],
        next_cursor: '',
      },
    ]);

    const result = await call('download_task_attachment', {
      task_id: 'task-1',
      attachment_id: 'attachment-1',
    });

    expect(request).toHaveBeenCalledWith({
      version: 'v3',
      path: '/workspaces/42/attachments/task-1/attachments',
      query: { cursor: undefined, limit: 100 },
    });
    expect(result.structuredContent?.data).toMatchObject({
      download_url: 'https://attachments.clickup.com/report',
    });
  });

  it('downloads to an explicit path without overwriting by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clickup-attachment-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'report.txt');
    const { call, download } = harness([
      {
        data: [{ id: 'attachment-1', url: 'https://attachments.clickup.com/report' }],
        next_cursor: '',
      },
    ]);
    download.mockResolvedValue({
      bytes: Buffer.from('contents'),
      contentLength: 8,
      contentType: 'text/plain',
      finalUrl: 'https://attachments.clickup.com/report',
    });

    await call('download_task_attachment', {
      task_id: 'task-1',
      attachment_id: 'attachment-1',
      destination_path: destination,
    });

    await expect(readFile(destination, 'utf8')).resolves.toBe('contents');
    expect(download).toHaveBeenCalledWith('https://attachments.clickup.com/report', 25 * 1024 * 1024);
  });
});
