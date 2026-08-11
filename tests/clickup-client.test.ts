import { describe, expect, it, vi } from 'vitest';

import { ClickUpClient } from '../src/clickup/client.js';
import type { AppConfig } from '../src/config.js';
import { noopLogger } from '../src/logging.js';

const config: AppConfig = {
  apiToken: 'pk_secret',
  defaultWorkspaceId: '42',
  enableDestructive: false,
  enableBulkWrites: false,
  bulkMaxItems: 25,
  searchMaxPages: 5,
  requestTimeoutMs: 5_000,
};

describe('ClickUpClient', () => {
  it('resolves explicit and configured Workspace IDs', () => {
    const client = new ClickUpClient(config, noopLogger, vi.fn<typeof fetch>());
    expect(client.requireWorkspaceId()).toBe('42');
    expect(client.requireWorkspaceId('99')).toBe('99');

    const withoutDefaultConfig: AppConfig = {
      apiToken: config.apiToken,
      enableDestructive: config.enableDestructive,
      enableBulkWrites: config.enableBulkWrites,
      bulkMaxItems: config.bulkMaxItems,
      searchMaxPages: config.searchMaxPages,
      requestTimeoutMs: config.requestTimeoutMs,
    };
    const withoutDefault = new ClickUpClient(
      withoutDefaultConfig,
      noopLogger,
      vi.fn<typeof fetch>(),
    );
    expect(() => withoutDefault.requireWorkspaceId()).toThrow(/workspace_id is required/);
  });

  it('adds authentication and serializes array query parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ClickUpClient(config, noopLogger, fetchMock);

    await client.request({
      path: '/team/42/task',
      query: { tags: ['urgent', 'backend'], include_closed: true },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const requestedUrl =
      url instanceof URL ? url.href : url instanceof Request ? url.url : (url ?? '');
    expect(requestedUrl).toContain('tags%5B%5D=urgent');
    expect(requestedUrl).toContain('tags%5B%5D=backend');
    expect(requestedUrl).toContain('include_closed=true');
    expect(new Headers(options?.headers).get('authorization')).toBe('pk_secret');
  });

  it('normalizes authorized workspaces and validates the configured default', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: 7 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: '42', name: 'Pappsales', members: [] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new ClickUpClient(config, noopLogger, fetchMock);

    await expect(client.validateAuthentication()).resolves.toEqual({
      userId: '7',
      workspaceIds: ['42'],
    });
  });

  it('does not retry failed writes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ err: 'failed', ECODE: 'TEST' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ClickUpClient(config, noopLogger, fetchMock);

    await expect(
      client.request({ path: '/list/1/task', method: 'POST', body: { name: 'Task' } }),
    ).rejects.toMatchObject({ code: 'TEST', retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('supports v3 JSON writes and empty responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ClickUpClient(config, noopLogger, fetchMock);

    await expect(
      client.request({
        version: 'v3',
        path: '/workspaces/42/tasks/t1/home_list/l1',
        method: 'PUT',
        body: { position: 0 },
      }),
    ).resolves.toEqual({});
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toContain('/api/v3/workspaces/42/tasks/t1/home_list/l1');
    expect(options?.body).toBe('{"position":0}');
  });

  it('rejects a default Workspace outside the authorized set', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: '7' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ teams: [{ id: '99' }] }), { status: 200 }));
    const client = new ClickUpClient(config, noopLogger, fetchMock);

    await expect(client.validateAuthentication()).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_AUTHORIZED',
    });
  });
});
