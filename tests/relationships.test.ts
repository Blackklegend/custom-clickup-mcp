import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerRelationshipTools } from '../src/tools/relationships.js';
import type { ToolDependencies } from '../src/tools/types.js';

interface ToolResult {
  isError?: boolean;
  structuredContent?: { error?: { code?: string } };
}
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function harness() {
  const handlers = new Map<string, ToolHandler>();
  const request = vi.fn<(request: ClickUpRequest) => Promise<unknown>>().mockResolvedValue({});
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerRelationshipTools(server, {
    client: { request, requireWorkspaceId: (explicit?: string) => explicit ?? '42' },
    logger: noopLogger,
  } as unknown as ToolDependencies);
  const call = async (name: string, input: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`Missing handler ${name}`);
    return handler(input);
  };
  return { call, request };
}

describe('relationship tools', () => {
  it('maps waiting_on to the ClickUp depends_on body', async () => {
    const { call, request } = harness();
    await call('add_dependency', {
      task_id: 'task-a',
      related_task_id: 'task-b',
      direction: 'waiting_on',
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/task-a/dependency',
      method: 'POST',
      query: {},
      body: { depends_on: 'task-b' },
    });
  });

  it('maps blocking to the ClickUp dependency_of removal query', async () => {
    const { call, request } = harness();
    await call('remove_dependency', {
      task_id: 'task-a',
      related_task_id: 'task-b',
      direction: 'blocking',
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/task-a/dependency',
      method: 'DELETE',
      query: { dependency_of: 'task-b' },
    });
  });

  it('prevents linking a Task to itself without an API call', async () => {
    const { call, request } = harness();
    const result = await call('add_task_link', {
      task_id: 'same',
      related_task_id: 'same',
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'SELF_RELATIONSHIP' } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the documented Task Link path', async () => {
    const { call, request } = harness();
    await call('remove_task_link', {
      task_id: 'task/a',
      related_task_id: 'task/b',
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/task%2Fa/link/task%2Fb',
      method: 'DELETE',
      query: {},
    });
  });
});
