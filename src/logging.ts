export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const REDACTED_KEYS = /authorization|token|secret|password|cookie|description|comment|email|query/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        REDACTED_KEYS.test(key) ? '[REDACTED]' : redact(child, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function createStderrLogger(): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(fields === undefined ? {} : { fields: redact(fields) }),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
