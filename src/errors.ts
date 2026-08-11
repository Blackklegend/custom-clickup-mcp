import { ZodError } from 'zod';

export class ToolFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolFailure';
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export class ClickUpApiError extends ToolFailure {
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ) {
    super(code, message, retryable, details);
    this.name = 'ClickUpApiError';
    this.status = status;
  }
}

export function normalizeError(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (error instanceof ZodError) {
    return new ToolFailure('INVALID_INPUT', 'Tool input did not match its schema.', false, {
      issues: error.issues.map(({ code, message, path }) => ({ code, message, path })),
    });
  }
  if (error instanceof Error) {
    return new ToolFailure('INTERNAL_ERROR', error.message || 'Unexpected error.', false);
  }
  return new ToolFailure('INTERNAL_ERROR', 'Unexpected error.', false);
}
