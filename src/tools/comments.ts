import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { asArray, asRecord, stringId } from '../utils/json.js';
import {
  IdSchema,
  additiveAnnotations,
  readOnlyAnnotations,
  registerClickUpTool,
  taskQuery,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const CursorValueSchema = z.string().regex(/^\d+$/, 'start must be an epoch millisecond string.');

const TaskReferenceFields = {
  task_id: IdSchema,
  custom_task_ids: z.boolean().optional().default(false),
  workspace_id: IdSchema.optional(),
} as const;

const GetTaskCommentsSchema = z
  .object({
    ...TaskReferenceFields,
    start: CursorValueSchema.optional(),
    start_id: IdSchema.optional(),
  })
  .strict();

const GetThreadedRepliesSchema = z.object({ comment_id: IdSchema }).strict();

const CommentTextPartSchema = z
  .object({
    text: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const CommentMentionPartSchema = z
  .object({
    type: z.literal('tag'),
    user: z.object({ id: IdSchema }).strict(),
  })
  .strict();

const CommentPartSchema = z.union([CommentTextPartSchema, CommentMentionPartSchema]);

const PlainTaskCommentSchema = z
  .object({
    ...TaskReferenceFields,
    comment_text: z.string().trim().min(1).max(100_000),
    notify_all: z.boolean().optional().default(false),
  })
  .strict();

const StructuredTaskCommentSchema = z
  .object({
    ...TaskReferenceFields,
    comment: z.array(CommentPartSchema).min(1).max(500),
    notify_all: z.boolean().optional().default(false),
  })
  .strict();

// A real union is emitted as JSON Schema anyOf; unlike superRefine, clients can inspect it.
const CreateTaskCommentSchema = z.union([
  PlainTaskCommentSchema,
  StructuredTaskCommentSchema,
]);

function requireCursorPair(start?: string, startId?: string): void {
  if ((start === undefined) !== (startId === undefined)) {
    throw new ToolFailure(
      'COMMENT_CURSOR_INVALID',
      'start and start_id must be provided together.',
      false,
    );
  }
}

function mentionId(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : value;
}

function structuredCommentBody(
  input: z.output<typeof CreateTaskCommentSchema>,
): Record<string, unknown> {
  if ('comment_text' in input) {
    return { comment_text: input.comment_text, notify_all: input.notify_all };
  }

  const comment = input.comment.map((part) => {
    if ('user' in part) {
      return { type: 'tag', user: { id: mentionId(part.user.id) } };
    }
    return {
      text: part.text,
      ...(part.attributes === undefined ? {} : { attributes: part.attributes }),
    };
  });
  return { comment, notify_all: input.notify_all };
}

function commentsPage(payload: unknown): {
  items: unknown[];
  has_more: boolean;
  next_cursor: { start: string; start_id: string } | null;
} {
  const response = asRecord(payload, 'task comments response');
  const items = asArray(response.comments);
  const last = items.at(-1);
  const lastRecord =
    last !== null && typeof last === 'object' && !Array.isArray(last)
      ? (last as Record<string, unknown>)
      : undefined;
  const start = lastRecord === undefined ? undefined : stringId(lastRecord.date);
  const startId = lastRecord === undefined ? undefined : stringId(lastRecord.id);
  const hasMore = items.length === 25 && start !== undefined && startId !== undefined;

  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore ? { start, start_id: startId } : null,
  };
}

export function registerCommentTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'get_task_comments',
    title: 'Get Task Comments',
    description: 'Get one reverse-chronological page of comments from a ClickUp Task.',
    inputSchema: GetTaskCommentsSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      requireCursorPair(input.start, input.start_id);
      const page = commentsPage(
        await dependencies.client.request({
          path: `/task/${encodeURIComponent(input.task_id)}/comment`,
          query: {
            ...taskQuery(dependencies, input),
            start: input.start,
            start_id: input.start_id,
          },
        }),
      );
      return {
        data: page,
        summary: `Retrieved ${page.items.length} comments for Task ${input.task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'get_threaded_replies',
    title: 'Get Threaded Replies',
    description: 'Get all replies beneath a ClickUp parent comment.',
    inputSchema: GetThreadedRepliesSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const response = asRecord(
        await dependencies.client.request({
          path: `/comment/${encodeURIComponent(input.comment_id)}/reply`,
        }),
        'threaded comments response',
      );
      const items = asArray(response.comments);
      return {
        data: { items, has_more: false, next_cursor: null },
        summary: `Retrieved ${items.length} replies for comment ${input.comment_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_task_comment',
    title: 'Create Task Comment',
    description: 'Add a plain-text or structured comment, including explicit user-ID mentions, to a Task.',
    inputSchema: CreateTaskCommentSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const response = asRecord(
        await dependencies.client.request({
          path: `/task/${encodeURIComponent(input.task_id)}/comment`,
          method: 'POST',
          query: taskQuery(dependencies, input),
          body: structuredCommentBody(input),
        }),
        'create task comment response',
      );
      const commentId = stringId(response.id);
      return {
        data: {
          task_id: input.task_id,
          ...(commentId === undefined ? {} : { comment_id: commentId }),
          response,
        },
        summary:
          commentId === undefined
            ? `Created a comment on Task ${input.task_id}.`
            : `Created comment ${commentId} on Task ${input.task_id}.`,
      };
    },
  });
}
