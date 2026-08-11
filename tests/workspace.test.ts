import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpClient, ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { registerWorkspaceTools } from '../src/tools/workspace.js';
import { MemoryCache } from '../src/utils/cache.js';

type Callback = (input: unknown) => Promise<{
  isError?: boolean;
  structuredContent?: { ok: boolean; data?: unknown; error?: { code: string } };
}>;

function setup(): { callbacks: Map<string, Callback>; request: ReturnType<typeof vi.fn> } {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _definition: unknown, callback: Callback) => callbacks.set(name, callback),
  } as unknown as McpServer;
  const request = vi.fn((input: ClickUpRequest) => {
    if (input.path === '/team/w1/space') {
      return Promise.resolve({ spaces: [{ id: 's1', name: 'Engineering' }] });
    }
    if (input.path === '/space/s1/folder') {
      return Promise.resolve({
        folders: [{
          id: 'f1',
          name: 'Roadmap',
          lists: [{ id: 'l1', name: 'Backlog' }],
          subfolders: [{ id: 'f2', name: 'Nested', parent_folder_id: 'f1', lists: [] }],
        }],
      });
    }
    if (input.path === '/space/s1/list') {
      return Promise.resolve({ lists: [{ id: 'l2', name: 'Inbox' }] });
    }
    if (input.method === 'POST' || input.method === 'PUT') return Promise.resolve({ id: 'new', name: 'Created' });
    return Promise.reject(new Error(`Unexpected request ${input.path}`));
  });
  const client = {
    requireWorkspaceId: (value?: string) => value ?? 'w1',
    request,
  } as unknown as ClickUpClient;
  registerWorkspaceTools(server, {
    client,
    logger: noopLogger,
    confirmations: new ConfirmationService(),
    cache: new MemoryCache(),
    config: {
      apiToken: 'test',
      enableDestructive: false,
      enableBulkWrites: false,
      bulkMaxItems: 25,
      searchMaxPages: 5,
      requestTimeoutMs: 15_000,
    },
  });
  return { callbacks, request };
}

describe('workspace tools', () => {
  it('builds and caches the normalized hierarchy for 60 seconds', async () => {
    const { callbacks, request } = setup();
    const callback = callbacks.get('get_workspace_hierarchy');
    const first = await callback?.({});
    const second = await callback?.({});
    const data = first?.structuredContent?.data as {
      spaces: Array<{
        folders: Array<{ subfolders: Array<{ parent_folder_id?: string }> }>;
        folderless_lists: unknown[];
      }>;
    };
    expect(data.spaces[0]?.folders).toHaveLength(1);
    expect(data.spaces[0]?.folderless_lists).toHaveLength(1);
    expect(data.spaces[0]?.folders[0]?.subfolders[0]?.parent_folder_id).toBe('f1');
    expect(second?.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('uses ClickUp numeric creation fields and documented update clearing values', async () => {
    const { callbacks, request } = setup();
    await callbacks.get('create_list_in_space')?.({
      space_id: 's1',
      name: 'New',
      priority: '2',
      assignee: '183',
    });
    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/space/s1/list',
      method: 'POST',
      body: { name: 'New', priority: 2, assignee: 183 },
    });

    await callbacks.get('update_list')?.({
      list_id: 'l1',
      name: 'Renamed',
      status: null,
      assignee: '183',
      priority: '3',
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/list/l1',
      method: 'PUT',
      body: { name: 'Renamed', unset_status: true, priority: 3, assignee: '183' },
    });
  });

  it('requires the documented List name on update', async () => {
    const { callbacks, request } = setup();
    const result = await callbacks.get('update_list')?.({ list_id: 'l1', status: null });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps hierarchy API concurrency at three requests', async () => {
    let active = 0;
    let peak = 0;
    const callbacks = new Map<string, Callback>();
    const server = {
      registerTool: (name: string, _definition: unknown, callback: Callback) => callbacks.set(name, callback),
    } as unknown as McpServer;
    const request = vi.fn(async (input: ClickUpRequest): Promise<unknown> => {
      if (input.path === '/team/w1/space') {
        return { spaces: Array.from({ length: 6 }, (_, index) => ({ id: `s${index}` })) };
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return input.path.endsWith('/folder') ? { folders: [] } : { lists: [] };
    });
    registerWorkspaceTools(server, {
      client: { requireWorkspaceId: () => 'w1', request } as unknown as ClickUpClient,
      logger: noopLogger,
      confirmations: new ConfirmationService(),
      cache: new MemoryCache(),
      config: {
        apiToken: 'test',
        enableDestructive: false,
        enableBulkWrites: false,
        bulkMaxItems: 25,
        searchMaxPages: 5,
        requestTimeoutMs: 15_000,
      },
    });

    await callbacks.get('get_workspace_hierarchy')?.({});
    expect(peak).toBe(3);
  });

  it('invalidates hierarchy cache after creating a List', async () => {
    const { callbacks, request } = setup();
    await callbacks.get('get_workspace_hierarchy')?.({});
    await callbacks.get('create_list_in_space')?.({ space_id: 's1', name: 'Created' });
    await callbacks.get('get_workspace_hierarchy')?.({});
    expect(request).toHaveBeenCalledTimes(7);
  });
});
