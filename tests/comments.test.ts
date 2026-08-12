import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { registerCommentTools } from '../src/tools/comments.js';
import type { ToolDependencies } from '../src/tools/types.js';

interface ToolResult {
  isError?: boolean;
  structuredContent?: { ok: boolean; data?: unknown; error?: { code?: string } };
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function harness(responses: unknown[], enableDestructive = false) {
  const handlers = new Map<string, ToolHandler>();
  const request = vi.fn<(request: ClickUpRequest) => Promise<unknown>>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  const requireWorkspaceId = vi.fn((explicit?: string) => explicit ?? '42');
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const dependencies = {
    client: { request, requireWorkspaceId },
    logger: noopLogger,
    config: { enableDestructive },
    confirmations: new ConfirmationService(),
  } as unknown as ToolDependencies;
  registerCommentTools(server, dependencies);
  const call = async (name: string, input: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`Missing handler ${name}`);
    return handler(input);
  };
  return { call, request, requireWorkspaceId };
}

describe('comment tools', () => {
  it('uses the composite comment cursor and returns the next one', async () => {
    const comments = Array.from({ length: 25 }, (_, index) => ({
      id: String(index + 1),
      date: 1_700_000_000_000 - index,
    }));
    const { call, request } = harness([{ comments }]);

    const result = await call('get_task_comments', {
      task_id: 'TASK-1',
      custom_task_ids: true,
      workspace_id: '99',
      start: '1700000000100',
      start_id: 'previous',
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/TASK-1/comment',
      query: {
        custom_task_ids: true,
        team_id: '99',
        start: '1700000000100',
        start_id: 'previous',
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        has_more: true,
        next_cursor: { start: String(comments[24]?.date), start_id: '25' },
      },
    });
  });

  it('rejects an incomplete comment cursor before calling ClickUp', async () => {
    const { call, request } = harness([]);
    const result = await call('get_task_comments', {
      task_id: 'abc',
      start: '1700000000000',
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'COMMENT_CURSOR_INVALID' } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('converts structured user mentions while keeping IDs strings in the MCP contract', async () => {
    const { call, request } = harness([{ id: '458', date: 1_700_000_000_000 }]);

    await call('create_task_comment', {
      task_id: 'abc',
      comment: [
        { text: 'Please review ' },
        { type: 'tag', user: { id: '183' } },
      ],
      notify_all: false,
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/abc/comment',
      method: 'POST',
      query: {},
      body: {
        comment: [{ text: 'Please review ' }, { type: 'tag', user: { id: 183 } }],
        notify_all: false,
      },
    });
  });

  it('creates comments on Tasks, Lists, and Chat views through the generic tool', async () => {
    const { call, request } = harness([{ id: '1' }, { id: '2' }, { id: '3' }]);

    await call('create_comment', {
      target: 'task',
      target_id: 'TASK-1',
      custom_task_ids: true,
      workspace_id: '99',
      comment_text: 'Task note',
      assignee: '183',
    });
    await call('create_comment', {
      target: 'list',
      target_id: 'list/1',
      comment_text: 'List note',
      assignee: '184',
    });
    await call('create_comment', {
      target: 'view',
      target_id: 'view/1',
      comment_text: 'View note',
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/task/TASK-1/comment',
      method: 'POST',
      query: { custom_task_ids: true, team_id: '99' },
      body: {
        comment_text: 'Task note',
        assignee: 183,
        notify_all: false,
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/list/list%2F1/comment',
      method: 'POST',
      body: { comment_text: 'List note', assignee: 184, notify_all: false },
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      path: '/view/view%2F1/comment',
      method: 'POST',
      body: { comment_text: 'View note', notify_all: false },
    });
  });

  it('creates a threaded reply and assigns it to a group', async () => {
    const { call, request } = harness([{ id: 'reply-1' }]);

    await call('create_comment', {
      reply_to_id: 'parent/1',
      comment_text: 'Following up',
      group_assignee: 'group-1',
      notify_all: true,
    });

    expect(request).toHaveBeenCalledWith({
      path: '/comment/parent%2F1/reply',
      method: 'POST',
      body: {
        comment_text: 'Following up',
        group_assignee: 'group-1',
        notify_all: true,
      },
    });
  });

  it('retrieves threaded replies from the parent comment endpoint', async () => {
    const { call, request } = harness([{ comments: [{ id: 'reply-1' }] }]);
    const result = await call('get_threaded_replies', { comment_id: 'parent/1' });

    expect(request).toHaveBeenCalledWith({ path: '/comment/parent%2F1/reply' });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { items: [{ id: 'reply-1' }], has_more: false, next_cursor: null },
    });
  });

  it('rejects missing or conflicting comment representations before calling ClickUp', async () => {
    const { call, request } = harness([]);
    const missing = await call('create_task_comment', { task_id: 'abc' });
    const conflicting = await call('create_task_comment', {
      task_id: 'abc',
      comment_text: 'plain',
      comment: [{ text: 'structured' }],
    });

    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    expect(conflicting).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('updates a comment with the complete replacement payload', async () => {
    const { call, request } = harness([{}]);

    await call('update_comment', {
      comment_id: 'comment/1',
      comment_text: 'Updated content',
      assignee: '183',
      group_assignee: 'group-1',
      resolved: true,
    });

    expect(request).toHaveBeenCalledWith({
      path: '/comment/comment%2F1',
      method: 'PUT',
      body: {
        comment_text: 'Updated content',
        assignee: 183,
        group_assignee: 'group-1',
        resolved: true,
      },
    });
  });

  it('requires a confirmed preview before deleting a comment', async () => {
    const { call, request } = harness([{}], true);
    const preview = await call('delete_comment', { comment_id: '456' });
    const previewData = preview.structuredContent?.data as
      | { confirmation_token?: string }
      | undefined;

    expect(request).not.toHaveBeenCalled();
    expect(previewData?.confirmation_token).toBeTypeOf('string');

    await call('delete_comment', {
      comment_id: '456',
      dry_run: false,
      confirm: true,
      confirmation_token: previewData?.confirmation_token,
    });

    expect(request).toHaveBeenCalledWith({ path: '/comment/456', method: 'DELETE' });
  });
});
