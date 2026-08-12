import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { registerCustomFieldTools } from '../src/tools/custom-fields.js';
import type { ToolDependencies } from '../src/tools/types.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: { data?: unknown };
}>;

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
  registerCustomFieldTools(server, {
    client: { request, requireWorkspaceId },
    logger: noopLogger,
  } as unknown as ToolDependencies);
  return {
    request,
    call: async (input: Record<string, unknown>) => handlers.get('get_custom_fields')!(input),
  };
}

describe('custom field discovery', () => {
  it('resolves a Task home List, filters applicability, and exposes option UUIDs', async () => {
    const { call, request } = harness([
      { id: 'task-1', custom_item_id: 7, list: { id: 'list-1' } },
      {
        fields: [
          {
            id: 'field-1',
            name: 'Stage',
            type: 'drop_down',
            type_config: { options: [{ id: 'option-1', name: 'Open' }] },
            applied_objects: [{ object_type: 19, object_id: 7 }],
          },
          {
            id: 'field-2',
            name: 'Other type only',
            type: 'text',
            applied_objects: [{ object_type: 19, object_id: 8 }],
          },
        ],
      },
    ]);

    const result = await call({
      location_type: 'task',
      location_id: 'CUSTOM-7',
      custom_task_ids: true,
      workspace_id: '99',
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/task/CUSTOM-7',
      query: { custom_task_ids: true, team_id: '99' },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/list/list-1/field',
      query: { include_applied_objects: true },
    });
    expect(result.structuredContent?.data).toMatchObject({
      count: 1,
      custom_item_id: '7',
      fields: [
        {
          id: 'field-1',
          options: [{ id: 'option-1', name: 'Open' }],
        },
      ],
    });
  });

  it('queries hierarchy locations directly', async () => {
    const { call, request } = harness([{ fields: [] }]);
    await call({ location_type: 'workspace', location_id: 'workspace/1' });

    expect(request).toHaveBeenCalledWith({
      path: '/team/workspace%2F1/field',
      query: { include_applied_objects: true },
    });
  });
});
