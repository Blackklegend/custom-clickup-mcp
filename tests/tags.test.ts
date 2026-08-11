import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerTagTools } from '../src/tools/tags.js';
import type { ToolDependencies } from '../src/tools/types.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

function harness() {
  const handlers = new Map<string, ToolHandler>();
  const request = vi.fn<(request: ClickUpRequest) => Promise<unknown>>().mockResolvedValue({});
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTagTools(server, {
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

describe('tag tools', () => {
  it('URL-encodes a tag and supplies the custom Task ID workspace query', async () => {
    const { call, request } = harness();
    await call('add_tag_to_task', {
      task_id: 'PAPP-1',
      tag_name: 'Needs review/QA',
      custom_task_ids: true,
      workspace_id: '99',
    });

    expect(request).toHaveBeenCalledWith({
      path: '/task/PAPP-1/tag/Needs%20review%2FQA',
      method: 'POST',
      query: { custom_task_ids: true, team_id: '99' },
    });
  });

  it('removes only the tag association', async () => {
    const { call, request } = harness();
    await call('remove_tag_from_task', { task_id: 'abc', tag_name: 'backend' });

    expect(request).toHaveBeenCalledWith({
      path: '/task/abc/tag/backend',
      method: 'DELETE',
      query: {},
    });
  });
});
