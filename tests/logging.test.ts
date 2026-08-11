import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStderrLogger } from '../src/logging.js';

describe('createStderrLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts credentials and user content', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createStderrLogger().info('test', {
      authorization: 'pk_secret',
      query: 'customer name',
      safe_count: 2,
    });

    const line = String(write.mock.calls[0]?.[0]);
    expect(line).not.toContain('pk_secret');
    expect(line).not.toContain('customer name');
    expect(line).toContain('safe_count');
  });
});
