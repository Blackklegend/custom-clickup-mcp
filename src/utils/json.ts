import { ToolFailure } from '../errors.js';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown, context = 'response'): JsonRecord {
  if (!isRecord(value)) {
    throw new ToolFailure('UPSTREAM_INVALID_RESPONSE', `Expected an object in ${context}.`, true);
  }
  return value;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
