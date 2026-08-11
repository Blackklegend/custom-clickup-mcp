import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { ToolFailure } from '../src/errors.js';

describe('loadConfig', () => {
  it('loads safe defaults', () => {
    expect(loadConfig({ CLICKUP_API_TOKEN: 'pk_test' })).toEqual({
      apiToken: 'pk_test',
      enableDestructive: false,
      enableBulkWrites: false,
      bulkMaxItems: 25,
      searchMaxPages: 5,
      requestTimeoutMs: 15_000,
    });
  });

  it('loads explicit configuration', () => {
    expect(
      loadConfig({
        CLICKUP_API_TOKEN: 'pk_test',
        CLICKUP_DEFAULT_WORKSPACE_ID: '123',
        CLICKUP_ENABLE_DESTRUCTIVE: 'true',
        CLICKUP_ENABLE_BULK_WRITES: 'true',
        CLICKUP_BULK_MAX_ITEMS: '50',
        CLICKUP_SEARCH_MAX_PAGES: '10',
        CLICKUP_REQUEST_TIMEOUT_MS: '30000',
      }),
    ).toMatchObject({
      defaultWorkspaceId: '123',
      enableDestructive: true,
      enableBulkWrites: true,
      bulkMaxItems: 50,
      searchMaxPages: 10,
      requestTimeoutMs: 30_000,
    });
  });

  it('rejects missing tokens', () => {
    expect(() => loadConfig({})).toThrowError(ToolFailure);
  });

  it('rejects unsafe numeric limits', () => {
    expect(() =>
      loadConfig({ CLICKUP_API_TOKEN: 'pk_test', CLICKUP_BULK_MAX_ITEMS: '101' }),
    ).toThrow(/between 1 and 100/);
  });

  it('rejects invalid boolean and non-integer settings', () => {
    expect(() =>
      loadConfig({ CLICKUP_API_TOKEN: 'pk_test', CLICKUP_ENABLE_DESTRUCTIVE: 'yes' }),
    ).toThrow(/must be "true" or "false"/);
    expect(() =>
      loadConfig({ CLICKUP_API_TOKEN: 'pk_test', CLICKUP_SEARCH_MAX_PAGES: '1.5' }),
    ).toThrow(/must be an integer/);
  });
});
