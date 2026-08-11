import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClickUpClient } from '../src/clickup/client.js';
import type { AppConfig } from '../src/config.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { createClickUpMcpServer } from '../src/server.js';
import { CORE_TOOL_NAMES } from '../src/tools/catalog.js';
import { TOOL_NAMES } from '../src/tools/index.js';
import { MemoryCache } from '../src/utils/cache.js';

const config: AppConfig = {
  apiToken: 'pk_test',
  defaultWorkspaceId: '42',
  toolProfile: 'full',
  enableDestructive: false,
  enableBulkWrites: false,
  bulkMaxItems: 25,
  searchMaxPages: 5,
  requestTimeoutMs: 5_000,
};

describe('MCP server integration', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map(async (closeable) => closeable.close()));
  });

  it('lists the exact P0 catalog and calls a tool with structured output', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: '99', name: 'Backlog' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const clickup = new ClickUpClient(config, noopLogger, fetchMock);
    const ensureAuthenticated = vi.fn(() => Promise.resolve());
    const server = createClickUpMcpServer({
      client: clickup,
      config,
      logger: noopLogger,
      ensureAuthenticated,
      confirmations: new ConfirmationService(),
      cache: new MemoryCache(),
    });
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([...TOOL_NAMES]);
    expect(listed.tools).toHaveLength(32);
    expect(listed.tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(26_000);
    expect(JSON.stringify(listed)).not.toContain('02-29');
    expect(listed.tools.find(({ name }) => name === 'create_task_comment')?.inputSchema).toHaveProperty(
      'anyOf',
    );
    expect(ensureAuthenticated).not.toHaveBeenCalled();

    const result = await client.callTool({ name: 'get_list', arguments: { list_id: '99' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      data: { id: '99', name: 'Backlog' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ensureAuthenticated).toHaveBeenCalledOnce();
  });

  it('exposes a compact core catalog with bounded discovery metadata', async () => {
    const coreConfig: AppConfig = { ...config, toolProfile: 'core' };
    const server = createClickUpMcpServer({
      client: new ClickUpClient(coreConfig, noopLogger),
      config: coreConfig,
      logger: noopLogger,
      confirmations: new ConfirmationService(),
      cache: new MemoryCache(),
    });
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([...CORE_TOOL_NAMES]);
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(12_000);

    const createTaskSchema = listed.tools.find(({ name }) => name === 'create_task')?.inputSchema;
    expect(JSON.stringify(createTaskSchema)).not.toContain('02-29');
    expect(createTaskSchema).toHaveProperty('properties.due_date.format', 'date-time');
  });
});
