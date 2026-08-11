import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerMoveTools } from '../src/tools/move.js';
import type { ToolDependencies } from '../src/tools/types.js';

interface ToolResult {
  structuredContent?: { data?: unknown };
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
  registerMoveTools(server, {
    client: { request, requireWorkspaceId },
    logger: noopLogger,
  } as unknown as ToolDependencies);
  const call = async (name: string, input: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`Missing handler ${name}`);
    return handler(input);
  };
  return { call, request, requireWorkspaceId };
}

describe('move tools', () => {
  it('reads the previous home List and moves through the v3 endpoint', async () => {
    const { call, request, requireWorkspaceId } = harness([
      { id: 'task-1', list: { id: 'old-list' } },
      { data: { task_id: 'task-1', new_list_id: 'new-list' } },
    ]);

    const result = await call('move_task_to_list', {
      workspace_id: '99',
      task_id: 'task-1',
      list_id: 'new-list',
      move_custom_fields: true,
      status_mappings: [
        { source_status: 'status-a', destination_status: 'status-b' },
      ],
    });

    expect(requireWorkspaceId).toHaveBeenCalledWith('99');
    expect(request).toHaveBeenNthCalledWith(1, { path: '/task/task-1' });
    expect(request).toHaveBeenNthCalledWith(2, {
      version: 'v3',
      path: '/workspaces/99/tasks/task-1/home_list/new-list',
      method: 'PUT',
      body: {
        move_custom_fields: true,
        status_mappings: [
          { source_status: 'status-a', destination_status: 'status-b' },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({
      data: { previous_list_id: 'old-list', new_list_id: 'new-list' },
    });
  });

  it('adds a Task to an additional v2 List while reporting its home List', async () => {
    const { call, request } = harness([{ list: { id: 'home-list' } }, {}]);
    const result = await call('add_task_to_list', {
      task_id: 'task/1',
      list_id: 'extra/1',
    });

    expect(request).toHaveBeenNthCalledWith(1, { path: '/task/task%2F1' });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/list/extra%2F1/task/task%2F1',
      method: 'POST',
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        home_list_id: 'home-list',
        added_list_id: 'extra/1',
        home_list_preserved: true,
      },
    });
  });
});
