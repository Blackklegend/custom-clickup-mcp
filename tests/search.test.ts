import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpClient, ClickUpRequest } from '../src/clickup/client.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { registerSearchTools } from '../src/tools/search.js';
import { MemoryCache } from '../src/utils/cache.js';

type Callback = (input: unknown) => Promise<{
  isError?: boolean;
  structuredContent?: { ok: boolean; data?: unknown; error?: { code: string } };
}>;
type RequestMock = ReturnType<
  typeof vi.fn<(input: ClickUpRequest) => Promise<unknown>>
>;

function setup(taskResponse: unknown): { callbacks: Map<string, Callback>; request: RequestMock } {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _definition: unknown, callback: Callback) => callbacks.set(name, callback),
  } as unknown as McpServer;
  const request = vi.fn<(input: ClickUpRequest) => Promise<unknown>>((input: ClickUpRequest) => {
    if (input.path === '/team/w1/task') return Promise.resolve(taskResponse);
    if (input.path === '/team/w1/custom_item') {
      return Promise.resolve({ custom_items: [{ id: 7, name: 'Bug' }] });
    }
    return Promise.reject(new Error(`Unexpected request ${input.path}`));
  });
  const client = {
    requireWorkspaceId: (value?: string) => value ?? 'w1',
    request,
  } as unknown as ClickUpClient;
  registerSearchTools(server, {
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
      searchMaxPages: 1,
      requestTimeoutMs: 15_000,
    },
  });
  return { callbacks, request };
}

describe('search tools', () => {
  it('matches task text case- and accent-insensitively', async () => {
    const { callbacks } = setup({
      tasks: [
        { id: 't1', name: 'Preparar café', description: '' },
        { id: 't2', name: 'Another task', description: '' },
      ],
      last_page: true,
    });
    const result = await callbacks.get('search_workspace')?.({
      query: 'CAFE',
      entity_types: ['task'],
    });
    const data = result?.structuredContent?.data as { items: Array<{ id: string }>; truncated: boolean };
    expect(data.items.map(({ id }) => id)).toEqual(['t1']);
    expect(data.truncated).toBe(false);
  });

  it('marks a bounded sweep as truncated and returns a continuation cursor', async () => {
    const tasks = Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, name: 'No match' }));
    const { callbacks } = setup({ tasks, last_page: false });
    const result = await callbacks.get('search_workspace')?.({
      query: 'target',
      entity_types: ['task'],
    });
    const data = result?.structuredContent?.data as {
      has_more: boolean;
      truncated: boolean;
      next_cursor: string;
    };
    expect(data.has_more).toBe(true);
    expect(data.truncated).toBe(true);
    expect(data.next_cursor).toEqual(expect.any(String));
  });

  it('resolves a task type and filters tasks by its ID', async () => {
    const { callbacks } = setup({
      tasks: [
        { id: 't1', name: 'Defect', custom_item_id: 7 },
        { id: 't2', name: 'Normal task', custom_item_id: 0 },
      ],
      last_page: true,
    });
    const result = await callbacks.get('filter_tasks')?.({ task_types: ['bug'] });
    const data = result?.structuredContent?.data as { items: Array<{ id: string }> };
    expect(data.items.map(({ id }) => id)).toEqual(['t1']);
  });

  it('composes task filters into one bounded upstream request', async () => {
    const dueFrom = '2026-08-11T00:00:00-03:00';
    const dueTo = '2026-08-18T00:00:00-03:00';
    const doneFrom = '2026-08-01T00:00:00-03:00';
    const doneTo = '2026-08-20T00:00:00-03:00';
    const { callbacks, request } = setup({
      tasks: [
        {
          id: 't1',
          name: 'Matching bug',
          custom_item_id: 7,
          tags: [{ name: 'Urgent' }],
          status: { status: 'in progress' },
          assignees: [{ id: 42 }],
          list: { id: '10' },
          folder: { id: '20' },
          space: { id: '30' },
          due_date: String(Date.parse('2026-08-12T00:00:00-03:00')),
          date_done: String(Date.parse('2026-08-15T00:00:00-03:00')),
        },
        {
          id: 't2',
          name: 'Rejected by client verification',
          custom_item_id: 7,
          tags: [{ name: 'Urgent' }],
          status: { status: 'closed' },
          assignees: [{ id: 42 }],
          list: { id: '10' },
          folder: { id: '20' },
          space: { id: '30' },
          due_date: String(Date.parse('2026-08-12T00:00:00-03:00')),
          date_done: String(Date.parse('2026-08-15T00:00:00-03:00')),
        },
      ],
      last_page: true,
    });

    const result = await callbacks.get('filter_tasks')?.({
      tags: ['urgent', 'backend'],
      statuses: ['to do', 'in progress'],
      assignees: ['42', '43'],
      list_ids: ['10'],
      folder_ids: ['20'],
      space_ids: ['30'],
      due_date_from: dueFrom,
      due_date_to: dueTo,
      completion_date_from: doneFrom,
      completion_date_to: doneTo,
      task_types: ['Bug', 'Task'],
      subtasks: false,
      order_by: 'due_date',
      reverse: true,
    });

    const data = result?.structuredContent?.data as { items: Array<{ id: string }> };
    expect(data.items.map(({ id }) => id)).toEqual(['t1']);
    const taskCall = request.mock.calls.find(([input]) => input.path === '/team/w1/task')?.[0];
    expect(taskCall?.query).toEqual({
      page: 0,
      include_closed: false,
      subtasks: false,
      tags: ['urgent', 'backend'],
      statuses: ['to do', 'in progress'],
      assignees: ['42', '43'],
      list_ids: ['10'],
      project_ids: ['20'],
      space_ids: ['30'],
      due_date_gt: Date.parse(dueFrom),
      due_date_lt: Date.parse(dueTo),
      date_done_gt: Date.parse(doneFrom),
      date_done_lt: Date.parse(doneTo),
      custom_items: ['7', '0'],
      order_by: 'due_date',
      reverse: true,
    });
    expect(request.mock.calls.filter(([input]) => input.path === '/team/w1/custom_item')).toHaveLength(1);
  });

  it('maps null custom_item_id to the built-in Task type and filters upstream', async () => {
    const { callbacks, request } = setup({
      tasks: [{ id: 't1', name: 'Standard', custom_item_id: null }],
      last_page: true,
    });
    const result = await callbacks.get('filter_tasks')?.({ task_types: ['Task'] });
    const data = result?.structuredContent?.data as { items: Array<{ id: string }> };
    expect(data.items.map(({ id }) => id)).toEqual(['t1']);
    const taskCall = request.mock.calls.find(([input]) => input.path === '/team/w1/task')?.[0];
    expect(taskCall?.query).toMatchObject({ custom_items: ['0'] });
  });

  it('does not return a continuation cursor at the exact end of the final page', async () => {
    const { callbacks } = setup({
      tasks: [{ id: 't1', name: 'Target' }],
      last_page: true,
    });
    const result = await callbacks.get('search_workspace')?.({
      query: 'target',
      entity_types: ['task'],
      limit: 1,
    });
    const data = result?.structuredContent?.data as { has_more: boolean; next_cursor?: string };
    expect(data.has_more).toBe(false);
    expect(data.next_cursor).toBeUndefined();
  });
});
