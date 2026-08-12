import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { asArray, asRecord, stringId } from '../utils/json.js';
import {
  IdSchema,
  NumericIdSchema,
  additiveAnnotations,
  mutatingAnnotations,
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
    assignee: NumericIdSchema.optional(),
    group_assignee: IdSchema.optional(),
    notify_all: z.boolean().optional().default(false),
  })
  .strict();

const StructuredTaskCommentSchema = z
  .object({
    ...TaskReferenceFields,
    comment: z.array(CommentPartSchema).min(1).max(500),
    assignee: NumericIdSchema.optional(),
    group_assignee: IdSchema.optional(),
    notify_all: z.boolean().optional().default(false),
  })
  .strict();

// A real union is emitted as JSON Schema anyOf; unlike superRefine, clients can inspect it.
const CreateTaskCommentSchema = z.union([
  PlainTaskCommentSchema,
  StructuredTaskCommentSchema,
]);

const CommentTargetSchema = z.enum(['task', 'list', 'view']);

const CreateCommentSchema = z
  .object({
    target: CommentTargetSchema.optional(),
    target_id: IdSchema.optional(),
    reply_to_id: IdSchema.optional(),
    custom_task_ids: z.boolean().optional().default(false),
    workspace_id: IdSchema.optional(),
    comment_text: z.string().trim().min(1).max(100_000).optional(),
    comment: z.array(CommentPartSchema).min(1).max(500).optional(),
    assignee: NumericIdSchema.optional(),
    group_assignee: IdSchema.optional(),
    notify_all: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    const hasTarget = input.target !== undefined || input.target_id !== undefined;
    const completeTarget = input.target !== undefined && input.target_id !== undefined;
    if ((hasTarget && !completeTarget) || (completeTarget === (input.reply_to_id !== undefined))) {
      context.addIssue({
        code: 'custom',
        message: 'Provide either target plus target_id, or reply_to_id.',
      });
    }
    if ((input.comment_text === undefined) === (input.comment === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of comment_text or comment.',
      });
    }
    if (
      input.target !== 'task' &&
      (input.custom_task_ids || input.workspace_id !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'custom_task_ids and workspace_id are only valid for a task target.',
      });
    }
    if (input.comment !== undefined && input.target !== 'task') {
      context.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Structured comments are only supported for a task target.',
      });
    }
    if (input.target === 'list' && input.assignee === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['assignee'],
        message: 'ClickUp requires assignee for a List comment.',
      });
    }
    if (
      (input.target === 'list' && input.group_assignee !== undefined) ||
      (input.target === 'view' &&
        (input.assignee !== undefined || input.group_assignee !== undefined))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The selected comment target does not support that assignment field.',
      });
    }
  });

const UpdateCommentSchema = z
  .object({
    comment_id: IdSchema,
    comment_text: z.string().trim().min(1).max(100_000),
    assignee: NumericIdSchema,
    group_assignee: IdSchema.optional(),
    resolved: z.boolean(),
  })
  .strict();

const DeleteCommentSchema = z
  .object({
    comment_id: IdSchema,
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    confirmation_token: z.string().min(1).optional(),
  })
  .strict();

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

interface CommentBodyInput {
  comment_text?: string | undefined;
  comment?: Array<z.output<typeof CommentPartSchema>> | undefined;
  assignee?: string | undefined;
  group_assignee?: string | undefined;
  notify_all: boolean;
}

function structuredCommentBody(input: CommentBodyInput): Record<string, unknown> {
  const assignment = {
    ...(input.assignee === undefined ? {} : { assignee: Number(input.assignee) }),
    ...(input.group_assignee === undefined ? {} : { group_assignee: input.group_assignee }),
  };
  if (input.comment_text !== undefined) {
    return {
      comment_text: input.comment_text,
      ...assignment,
      notify_all: input.notify_all,
    };
  }

  if (input.comment === undefined) {
    throw new ToolFailure('COMMENT_CONTENT_INVALID', 'Comment content is missing.', false);
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
  return { comment, ...assignment, notify_all: input.notify_all };
}

function createCommentRequest(
  dependencies: ToolDependencies,
  input: z.output<typeof CreateCommentSchema>,
): { path: string; query?: Record<string, string | boolean> } {
  if (input.reply_to_id !== undefined) {
    return { path: `/comment/${encodeURIComponent(input.reply_to_id)}/reply` };
  }
  if (input.target === undefined || input.target_id === undefined) {
    throw new ToolFailure('COMMENT_TARGET_INVALID', 'Comment target is missing.', false);
  }
  return {
    path: `/${input.target}/${encodeURIComponent(input.target_id)}/comment`,
    ...(input.target === 'task'
      ? { query: taskQuery(dependencies, input) }
      : {}),
  };
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
    name: 'create_comment',
    title: 'Create Comment',
    description:
      'Add a comment to a Task, List, or Chat view, or reply beneath an existing comment; optionally assign it to a user or group.',
    inputSchema: CreateCommentSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const request = createCommentRequest(dependencies, input);
      const response = asRecord(
        await dependencies.client.request({
          ...request,
          method: 'POST',
          body: structuredCommentBody(input),
        }),
        'create comment response',
      );
      const commentId = stringId(response.id);
      const destination = input.reply_to_id !== undefined
        ? `comment ${input.reply_to_id}`
        : `${input.target} ${input.target_id}`;
      return {
        data: {
          ...(input.reply_to_id !== undefined
            ? { reply_to_id: input.reply_to_id }
            : { target: input.target, target_id: input.target_id }),
          ...(commentId === undefined ? {} : { comment_id: commentId }),
          response,
        },
        summary:
          commentId === undefined
            ? `Created a comment on ${destination}.`
            : `Created comment ${commentId} on ${destination}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_task_comment',
    title: 'Create Task Comment',
    description:
      'Compatibility tool for adding a plain-text or structured comment to a Task. Prefer create_comment for new integrations.',
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

  registerClickUpTool(server, dependencies, {
    name: 'update_comment',
    title: 'Update Comment',
    description: 'Replace a task comment and set its assignee and resolved state.',
    inputSchema: UpdateCommentSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const response = await dependencies.client.request({
        path: `/comment/${encodeURIComponent(input.comment_id)}`,
        method: 'PUT',
        body: {
          comment_text: input.comment_text,
          assignee: Number(input.assignee),
          ...(input.group_assignee === undefined
            ? {}
            : { group_assignee: input.group_assignee }),
          resolved: input.resolved,
        },
      });
      return {
        data: { comment_id: input.comment_id, response },
        summary: `Updated comment ${input.comment_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'delete_comment',
    title: 'Delete Comment',
    description: 'Preview or explicitly confirm permanent deletion of a task comment.',
    inputSchema: DeleteCommentSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const payload = { comment_id: input.comment_id };
      if (input.dry_run) {
        return {
          data: {
            dry_run: true,
            comment_id: input.comment_id,
            destructive_writes_enabled: dependencies.config.enableDestructive,
            confirmation_token: dependencies.confirmations.create(
              'delete_comment',
              input.comment_id,
              payload,
            ),
            confirmation_expires_in_seconds: 600,
          },
          summary: 'Comment deletion preview generated; no comment was deleted.',
        };
      }
      if (!dependencies.config.enableDestructive) {
        throw new ToolFailure(
          'DESTRUCTIVE_WRITES_DISABLED',
          'Comment deletion requires CLICKUP_ENABLE_DESTRUCTIVE=true.',
          false,
        );
      }
      if (!input.confirm || input.confirmation_token === undefined) {
        throw new ToolFailure(
          'CONFIRMATION_REQUIRED',
          'Comment deletion requires confirm=true and the confirmation_token from a preview.',
          false,
        );
      }
      dependencies.confirmations.verifyAndConsume(
        input.confirmation_token,
        'delete_comment',
        input.comment_id,
        payload,
      );
      await dependencies.client.request({
        path: `/comment/${encodeURIComponent(input.comment_id)}`,
        method: 'DELETE',
      });
      return {
        data: { deleted: true, comment_id: input.comment_id },
        summary: `Deleted comment ${input.comment_id}.`,
      };
    },
  });
}
