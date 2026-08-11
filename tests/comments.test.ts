import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerCommentTools } from '../src/tools/comments.js';
import type { ToolDependencies } from '../src/tools/types.js';

interface ToolResult {
  isError?: boolean;
  structuredContent?: { ok: boolean; data?: unknown; error?: { code?: string } };
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function harness(responses: unknown[]) {
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
    config: { enableDestructive: false },
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
});
