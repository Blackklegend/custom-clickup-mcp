import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpClient } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { registerMemberTools } from '../src/tools/members.js';
import type { ToolDependencies } from '../src/tools/types.js';
import { MemoryCache } from '../src/utils/cache.js';

type Callback = (input: unknown) => Promise<{
  isError?: boolean;
  structuredContent?: { ok: boolean; data?: unknown; error?: { code: string } };
}>;

function setup(): {
  callbacks: Map<string, Callback>;
  getAuthorizedWorkspaces: ReturnType<typeof vi.fn>;
} {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _definition: unknown, callback: Callback) => callbacks.set(name, callback),
  } as unknown as McpServer;
  const getAuthorizedWorkspaces = vi.fn().mockResolvedValue([
    {
      id: 'w1',
      members: [
        { user: { id: 1, username: 'José Silva', email: 'jose@example.com', role: 2 } },
        { user: { id: 2, username: 'Jose Santos', email: 'santos@example.com', role: 4 } },
        { user: { id: 3, username: 'Maria Lima', email: 'maria@example.com', role: 3 } },
      ],
    },
  ]);
  const client = {
    requireWorkspaceId: (value?: string) => value ?? 'w1',
    getAuthorizedWorkspaces,
  } as unknown as ClickUpClient;
  const dependencies: ToolDependencies = {
    client,
    logger: noopLogger,
    confirmations: new ConfirmationService(),
    cache: new MemoryCache(),
    config: {
      apiToken: 'test',
      toolProfile: 'full',
      enableDestructive: false,
      enableBulkWrites: false,
      bulkMaxItems: 25,
      searchMaxPages: 5,
      requestTimeoutMs: 15_000,
    },
  };
  registerMemberTools(server, dependencies);
  return { callbacks, getAuthorizedWorkspaces };
}

function dataOf(result: Awaited<ReturnType<Callback>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  return result.structuredContent?.data as Record<string, unknown>;
}

describe('member tools', () => {
  it('returns candidates instead of choosing an ambiguous normalized name', async () => {
    const { callbacks } = setup();
    const result = await callbacks.get('find_member_by_name')?.({ query: 'jose' });
    const data = dataOf(result as Awaited<ReturnType<Callback>>);
    expect(data.status).toBe('ambiguous');
    expect(data.candidates).toHaveLength(2);
  });

  it('groups resolved, ambiguous and missing assignees', async () => {
    const { callbacks, getAuthorizedWorkspaces } = setup();
    const result = await callbacks.get('resolve_assignees')?.({
      assignees: ['maria@example.com', 'José', 'Nobody'],
    });
    const data = dataOf(result as Awaited<ReturnType<Callback>>);
    expect(data.resolved).toHaveLength(1);
    expect(data.ambiguous).toHaveLength(1);
    expect(data.not_found).toEqual(['Nobody']);
    expect(data.all_resolved).toBe(false);
    expect(getAuthorizedWorkspaces).toHaveBeenCalledTimes(1);
  });
});
