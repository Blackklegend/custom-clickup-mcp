import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStderrLogger } from '../src/logging.js';

describe('createStderrLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts credentials, user content, resource paths, and identifiers', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createStderrLogger().info('test', {
      authorization: 'pk_secret',
      query: 'customer name',
      path: '/task/sensitive-task-id',
      user_id: 'sensitive-user-id',
      workspaceIds: ['sensitive-workspace-id'],
      safe_count: 2,
    });

    const line = String(write.mock.calls[0]?.[0]);
    expect(line).not.toContain('pk_secret');
    expect(line).not.toContain('customer name');
    expect(line).not.toContain('sensitive-task-id');
    expect(line).not.toContain('sensitive-user-id');
    expect(line).not.toContain('sensitive-workspace-id');
    expect(line).toContain('safe_count');
  });
});
