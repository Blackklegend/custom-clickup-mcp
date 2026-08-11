import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { ClickUpClient } from '../src/clickup/client.js';
import type { AppConfig } from '../src/config.js';
import { noopLogger } from '../src/logging.js';
import { ConfirmationService } from '../src/policies/confirmation.js';
import { registerTaskTools, TASK_TOOL_NAMES } from '../src/tools/tasks.js';
import type { ToolDependencies } from '../src/tools/types.js';
import { MemoryCache } from '../src/utils/cache.js';

type ToolCallback = (input: unknown) => Promise<CallToolResult>;

interface RecordedRequest {
  method: string;
  url: URL;
  body?: unknown;
}

interface Harness {
  callbacks: Map<string, ToolCallback>;
  requests: RecordedRequest[];
  fetchMock: ReturnType<typeof vi.fn>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createHarness(
  overrides: Partial<AppConfig> = {},
  responder: (request: RecordedRequest) => Response | Promise<Response> = () => jsonResponse({}),
  includeDefaultWorkspace = true,
): Harness {
  const config: AppConfig = {
    apiToken: 'test-token',
    ...(includeDefaultWorkspace ? { defaultWorkspaceId: '9001' } : {}),
    toolProfile: 'full',
    enableDestructive: false,
    enableBulkWrites: false,
    bulkMaxItems: 25,
    searchMaxPages: 5,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(typeof input === 'string' || input instanceof URL ? input : input.url),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    requests.push(request);
    return responder(request);
  });
  const client = new ClickUpClient(config, noopLogger, fetchMock);
  const dependencies: ToolDependencies = {
    client,
    config,
    logger: noopLogger,
    confirmations: new ConfirmationService(),
    cache: new MemoryCache(),
  };
  const callbacks = new Map<string, ToolCallback>();
  const server = {
    registerTool: (name: string, _definition: unknown, callback: ToolCallback) => {
      callbacks.set(name, callback);
    },
  } as unknown as McpServer;
  registerTaskTools(server, dependencies);
  return { callbacks, requests, fetchMock };
}

function dataOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent as
    | { ok?: boolean; data?: Record<string, unknown> }
    | undefined;
  expect(structured?.ok).toBe(true);
  expect(structured?.data).toBeDefined();
  return structured?.data ?? {};
}

function errorCodeOf(result: CallToolResult): string | undefined {
  const structured = result.structuredContent as
    | { ok?: boolean; error?: { code?: string } }
    | undefined;
  return structured?.error?.code;
}

describe('task tools', () => {
  it('registers the seven P0 task tools', () => {
    const { callbacks } = createHarness();
    expect([...callbacks.keys()]).toEqual(TASK_TOOL_NAMES);
  });

  it('creates tasks with strict input and converts ClickUp payload values', async () => {
    const harness = createHarness({}, () => jsonResponse({ id: 'task-1', name: 'New task' }));
    const callback = harness.callbacks.get('create_task');
    expect(callback).toBeDefined();

    const rejected = await callback?.({ list_id: 'list/1', name: 'No', unexpected: true });
    expect(rejected?.isError).toBe(true);
    expect(harness.requests).toHaveLength(0);

    const invalidDate = await callback?.({
      list_id: 'list/1',
      name: 'No date',
      due_date: 'not-a-date',
    });
    expect(invalidDate?.isError).toBe(true);
    expect(harness.requests).toHaveLength(0);

    const result = await callback?.({
      list_id: 'list/1',
      name: 'New task',
      markdown_description: '**Details**',
      assignees: ['42'],
      priority: '2',
      due_date: '2026-08-11T12:00:00-03:00',
      custom_item_id: '7',
    });

    expect(result?.isError).not.toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.method).toBe('POST');
    expect(harness.requests[0]?.url.pathname).toBe('/api/v2/list/list%2F1/task');
    expect(harness.requests[0]?.body).toEqual({
      name: 'New task',
      markdown_content: '**Details**',
      assignees: [42],
      priority: 2,
      due_date: Date.parse('2026-08-11T12:00:00-03:00'),
      custom_item_id: 7,
    });
  });

  it('requires a workspace and sends the documented query for Custom Task IDs', async () => {
    const withoutDefault = createHarness({}, undefined, false);
    const missingWorkspace = await withoutDefault.callbacks.get('get_task')?.({
      task_id: 'CUSTOM-7',
      custom_task_ids: true,
    });
    expect(errorCodeOf(missingWorkspace as CallToolResult)).toBe('WORKSPACE_REQUIRED');
    expect(withoutDefault.requests).toHaveLength(0);

    const harness = createHarness({}, () => jsonResponse({ id: 'abc' }));
    await harness.callbacks.get('get_task')?.({
      task_id: 'CUSTOM-7',
      custom_task_ids: true,
      workspace_id: '4321',
      include_subtasks: true,
    });
    const url = harness.requests[0]?.url;
    expect(url?.searchParams.get('custom_task_ids')).toBe('true');
    expect(url?.searchParams.get('team_id')).toBe('4321');
    expect(url?.searchParams.get('include_subtasks')).toBe('true');
  });

  it('updates only supplied fields and uses ClickUp assignee delta payloads', async () => {
    const harness = createHarness({}, () => jsonResponse({ id: 'task-1' }));
    await harness.callbacks.get('update_task')?.({
      task_id: 'task-1',
      priority: null,
      assignees: { add: ['10'], rem: ['11'] },
      archived: false,
    });
    expect(harness.requests[0]?.method).toBe('PUT');
    expect(harness.requests[0]?.body).toEqual({
      priority: null,
      assignees: { add: [10], rem: [11] },
      archived: false,
    });
  });

  it('discovers and validates every custom field before writing', async () => {
    const harness = createHarness({}, (request) => {
      if (request.url.pathname.endsWith('/task/task-1')) {
        return jsonResponse({ id: 'task-1', list: { id: 'list-1' } });
      }
      if (request.url.pathname.endsWith('/list/list-1/field')) {
        return jsonResponse({
          fields: [
            {
              id: 'field-1',
              name: 'Stage',
              type: 'drop_down',
              type_config: { options: [{ id: 'option-1', name: 'Open' }] },
            },
          ],
        });
      }
      return jsonResponse({});
    });

    const invalid = await harness.callbacks.get('set_task_custom_fields')?.({
      task_id: 'task-1',
      fields: [{ field_id: 'field-1', value: 'not-an-option' }],
    });
    expect(errorCodeOf(invalid as CallToolResult)).toBe('CUSTOM_FIELD_OPTION_INVALID');
    expect(harness.requests).toHaveLength(2);

    const valid = await harness.callbacks.get('set_task_custom_fields')?.({
      task_id: 'task-1',
      fields: [{ field_id: 'field-1', value: 'option-1' }],
      dry_run: false,
    });
    expect(valid?.isError).not.toBe(true);
    expect(harness.requests[4]?.url.pathname).toBe('/api/v2/task/task-1/field/field-1');
    expect(harness.requests[4]?.method).toBe('POST');
    expect(harness.requests[4]?.body).toEqual({ value: 'option-1' });
  });

  it('rejects fields scoped to a different Custom Task Type before writing', async () => {
    const harness = createHarness({}, (request) => {
      if (request.url.pathname.endsWith('/task/task-1')) {
        return jsonResponse({ id: 'task-1', custom_item_id: 7, list: { id: 'list-1' } });
      }
      return jsonResponse({
        fields: [
          {
            id: 'field-1',
            name: 'Scoped',
            type: 'text',
            applied_objects: [{ object_type: 19, object_id: 8 }],
          },
        ],
      });
    });

    const result = await harness.callbacks.get('set_task_custom_fields')?.({
      task_id: 'task-1',
      fields: [{ field_id: 'field-1', value: 'value' }],
      dry_run: false,
    });
    expect(errorCodeOf(result as CallToolResult)).toBe('CUSTOM_FIELD_NOT_APPLICABLE');
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.url.searchParams.get('include_applied_objects')).toBe('true');
  });

  it('previews removals and keeps them disabled without the destructive flag', async () => {
    const harness = createHarness({}, (request) => {
      if (request.url.pathname.endsWith('/task/task-1')) {
        return jsonResponse({ id: 'task-1', custom_item_id: null, list: { id: 'list-1' } });
      }
      return jsonResponse({ fields: [{ id: 'field-1', name: 'Text', type: 'text' }] });
    });
    const callback = harness.callbacks.get('set_task_custom_fields');
    const preview = await callback?.({
      task_id: 'task-1',
      fields: [{ field_id: 'field-1', unset: true }],
    });
    const token = dataOf(preview as CallToolResult).confirmation_token;
    const execution = await callback?.({
      task_id: 'task-1',
      fields: [{ field_id: 'field-1', unset: true }],
      dry_run: false,
      confirm: true,
      confirmation_token: token,
    });
    expect(errorCodeOf(execution as CallToolResult)).toBe('DESTRUCTIVE_WRITES_DISABLED');
    expect(harness.requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('reports partial failure for a confirmed multi-field update', async () => {
    const harness = createHarness(
      { enableBulkWrites: true },
      (request) => {
        if (request.url.pathname.endsWith('/task/task-1')) {
          return jsonResponse({ id: 'task-1', custom_item_id: null, list: { id: 'list-1' } });
        }
        if (request.url.pathname.endsWith('/list/list-1/field')) {
          return jsonResponse({
            fields: [
              { id: 'field-1', name: 'One', type: 'text' },
              { id: 'field-2', name: 'Two', type: 'text' },
            ],
          });
        }
        if (request.url.pathname.endsWith('/field/field-2')) {
          return jsonResponse({ err: 'Rejected' }, 400);
        }
        return jsonResponse({});
      },
    );
    const callback = harness.callbacks.get('set_task_custom_fields');
    const fields = [
      { field_id: 'field-1', value: 'first' },
      { field_id: 'field-2', value: 'second' },
    ];
    const preview = await callback?.({ task_id: 'task-1', fields });
    const token = dataOf(preview as CallToolResult).confirmation_token;
    const result = await callback?.({
      task_id: 'task-1',
      fields,
      dry_run: false,
      confirm: true,
      confirmation_token: token,
    });
    expect(dataOf(result as CallToolResult)).toMatchObject({
      updated: 1,
      failed: 1,
      partial_failure: true,
    });
  });

  it('deletes only after preview, enabled feature flag, and consumable confirmation', async () => {
    const harness = createHarness({ enableDestructive: true }, (request) => {
      if (request.method === 'DELETE') return jsonResponse({}, 204);
      return jsonResponse({
        id: 'task-1',
        name: 'Risky task',
        list: { id: 'list-1', name: 'Backlog' },
      });
    });
    const callback = harness.callbacks.get('delete_task');
    const preview = await callback?.({ task_id: 'task-1' });
    const previewData = dataOf(preview as CallToolResult);
    const token = previewData.confirmation_token;
    expect(typeof token).toBe('string');
    expect(harness.requests[0]?.method).toBe('GET');

    const deleted = await callback?.({
      task_id: 'task-1',
      dry_run: false,
      confirm: true,
      confirmation_token: token,
    });
    expect(dataOf(deleted as CallToolResult)).toMatchObject({ deleted: true, task_id: 'task-1' });
    expect(harness.requests[1]?.method).toBe('DELETE');

    const replay = await callback?.({
      task_id: 'task-1',
      dry_run: false,
      confirm: true,
      confirmation_token: token,
    });
    expect(errorCodeOf(replay as CallToolResult)).toBe('CONFIRMATION_CONSUMED');
    expect(harness.requests).toHaveLength(2);
  });

  it('bulk creates with concurrency three and reports each failure without rollback', async () => {
    let active = 0;
    let peak = 0;
    const harness = createHarness({ enableBulkWrites: true, bulkMaxItems: 10 }, async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (request.url.pathname.includes('/list/fail/')) {
        return jsonResponse({ err: 'Rejected' }, 400);
      }
      return jsonResponse({ id: request.url.pathname });
    });
    const callback = harness.callbacks.get('create_bulk_tasks');
    const items = [
      { list_id: 'one', name: 'One' },
      { list_id: 'two', name: 'Two' },
      { list_id: 'fail', name: 'Failure' },
      { list_id: 'four', name: 'Four' },
      { list_id: 'five', name: 'Five' },
    ];
    const preview = await callback?.({ items });
    const token = dataOf(preview as CallToolResult).confirmation_token;
    expect(harness.requests).toHaveLength(0);

    const result = await callback?.({
      items,
      dry_run: false,
      confirm: true,
      confirmation_token: token,
    });
    expect(dataOf(result as CallToolResult)).toMatchObject({
      total: 5,
      succeeded: 4,
      failed: 1,
      partial_failure: true,
    });
    expect(peak).toBe(3);
    expect(harness.requests).toHaveLength(5);
  });

  it('enforces the configured bulk item limit before issuing a preview token', async () => {
    const harness = createHarness({ bulkMaxItems: 1 });
    const result = await harness.callbacks.get('update_bulk_tasks')?.({
      items: [
        { task_id: 'one', name: 'First' },
        { task_id: 'two', name: 'Second' },
      ],
    });
    expect(errorCodeOf(result as CallToolResult)).toBe('BULK_LIMIT_EXCEEDED');
    expect(harness.requests).toHaveLength(0);
  });
});
