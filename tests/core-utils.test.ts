import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { normalizeError, ToolFailure } from '../src/errors.js';
import { MemoryCache } from '../src/utils/cache.js';
import {
  asArray,
  asRecord,
  isRecord,
  numberValue,
  stringId,
  stringValue,
} from '../src/utils/json.js';
import { includesNormalized, normalizeSearchText } from '../src/utils/text.js';
import { ToolEnvelopeSchema } from '../src/tools/shared.js';

describe('core utilities', () => {
  afterEach(() => vi.useRealTimers());

  it('normalizes unknown errors', () => {
    const known = new ToolFailure('KNOWN', 'known', false);
    expect(normalizeError(known)).toBe(known);
    expect(normalizeError(new Error('boom'))).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'boom',
    });
    expect(normalizeError(null)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(normalizeError(z.string().safeParse(1).error)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('supports expiring and prefix-invalidated memory cache entries', () => {
    vi.useFakeTimers();
    const cache = new MemoryCache();
    cache.set('workspace:1', { id: 1 }, 100);
    cache.set('member:1', { id: 2 }, 100);
    expect(cache.get('workspace:1')).toEqual({ id: 1 });

    cache.deletePrefix('workspace:');
    expect(cache.get('workspace:1')).toBeUndefined();
    vi.advanceTimersByTime(101);
    expect(cache.get('member:1')).toBeUndefined();

    cache.set('other', true, 100);
    cache.clear();
    expect(cache.get('other')).toBeUndefined();
  });

  it('narrows JSON values and IDs', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(asRecord({ id: 1 })).toEqual({ id: 1 });
    expect(() => asRecord('bad')).toThrow(/Expected an object/);
    expect(asArray([1])).toEqual([1]);
    expect(asArray(null)).toEqual([]);
    expect(stringId(12)).toBe('12');
    expect(stringId('abc')).toBe('abc');
    expect(stringId('')).toBeUndefined();
    expect(stringValue('value')).toBe('value');
    expect(stringValue(1)).toBeUndefined();
    expect(numberValue(1)).toBe(1);
    expect(numberValue(Number.NaN)).toBeUndefined();
  });

  it('normalizes accents, case, and whitespace for search', () => {
    expect(normalizeSearchText('  São   Paulo  ')).toBe('sao paulo');
    expect(includesNormalized('Cliente São Paulo', 'sao')).toBe(true);
    expect(includesNormalized(undefined, 'sao')).toBe(false);
  });

  it('enforces mutually exclusive success and error tool envelopes', () => {
    expect(ToolEnvelopeSchema.safeParse({ ok: true, data: {} }).success).toBe(true);
    expect(
      ToolEnvelopeSchema.safeParse({
        ok: false,
        error: { code: 'FAILED', message: 'failed', retryable: false },
      }).success,
    ).toBe(true);
    expect(ToolEnvelopeSchema.safeParse({ ok: true, error: {} }).success).toBe(false);
    expect(ToolEnvelopeSchema.safeParse({ ok: false, data: {} }).success).toBe(false);
  });
});
