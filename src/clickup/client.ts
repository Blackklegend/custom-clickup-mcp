import { setTimeout as delay } from 'node:timers/promises';

import type { AppConfig } from '../config.js';
import { ClickUpApiError, ToolFailure } from '../errors.js';
import type { Logger } from '../logging.js';
import { asArray, asRecord, stringId } from '../utils/json.js';

export type ApiVersion = 'v2' | 'v3';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | null | undefined;

export interface ClickUpRequest {
  version?: ApiVersion;
  path: string;
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeoutMs?: number;
}

export interface AuthorizedWorkspace {
  id: string;
  name?: string;
  members: unknown[];
  raw: Record<string, unknown>;
}

type FetchLike = typeof fetch;

class RateLimitGate {
  #remaining = Number.POSITIVE_INFINITY;
  #resetAtMs = 0;
  #queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<void> {
    let release = (): void => undefined;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#remaining <= 0 && this.#resetAtMs > Date.now()) {
        await delay(this.#resetAtMs - Date.now() + Math.floor(Math.random() * 250));
      }
      if (this.#remaining <= 0 && this.#resetAtMs <= Date.now()) {
        this.#remaining = Number.POSITIVE_INFINITY;
      }
      if (Number.isFinite(this.#remaining) && this.#remaining > 0) this.#remaining -= 1;
    } finally {
      release();
    }
  }

  observe(headers: Headers): void {
    const remainingHeader = headers.get('x-ratelimit-remaining');
    const resetHeader = headers.get('x-ratelimit-reset');
    if (remainingHeader !== null) {
      const remaining = Number(remainingHeader);
      if (Number.isFinite(remaining)) this.#remaining = remaining;
    }
    if (resetHeader !== null) {
      const resetSeconds = Number(resetHeader);
      if (Number.isFinite(resetSeconds)) this.#resetAtMs = resetSeconds * 1_000;
    }
  }

  retryDelay(headers: Headers, attempt: number): number {
    const resetHeader = headers.get('x-ratelimit-reset');
    if (resetHeader !== null) {
      const resetSeconds = Number(resetHeader);
      if (Number.isFinite(resetSeconds)) {
        return Math.max(0, resetSeconds * 1_000 - Date.now()) + Math.floor(Math.random() * 250);
      }
    }
    return Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
  }
}

function buildUrl(version: ApiVersion, path: string, query?: Record<string, QueryValue>): URL {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`https://api.clickup.com/api/${version}${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
      for (const item of value) url.searchParams.append(arrayKey, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 1_000) };
  }
}

function upstreamError(response: Response, payload: unknown): ClickUpApiError {
  const record =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const upstreamCode = typeof record.ECODE === 'string' ? record.ECODE : undefined;
  const message =
    typeof record.err === 'string'
      ? record.err
      : typeof record.message === 'string'
        ? record.message
        : `ClickUp API returned HTTP ${response.status}.`;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new ClickUpApiError(
    response.status,
    upstreamCode ?? `CLICKUP_HTTP_${response.status}`,
    message,
    retryable,
    upstreamCode === undefined ? undefined : { upstream_code: upstreamCode },
  );
}

export class ClickUpClient {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #rateLimit = new RateLimitGate();

  constructor(config: AppConfig, logger: Logger, fetchImplementation: FetchLike = fetch) {
    this.#config = config;
    this.#logger = logger;
    this.#fetch = fetchImplementation;
  }

  get defaultWorkspaceId(): string | undefined {
    return this.#config.defaultWorkspaceId;
  }

  requireWorkspaceId(explicit?: string): string {
    const workspaceId = explicit ?? this.#config.defaultWorkspaceId;
    if (workspaceId === undefined) {
      throw new ToolFailure(
        'WORKSPACE_REQUIRED',
        'workspace_id is required when CLICKUP_DEFAULT_WORKSPACE_ID is not configured.',
        false,
      );
    }
    return workspaceId;
  }

  async request<T = unknown>(request: ClickUpRequest): Promise<T> {
    const method = request.method ?? 'GET';
    const version = request.version ?? 'v2';
    const url = buildUrl(version, request.path, request.query);
    const maxAttempts = method === 'GET' ? 3 : 1;
    const startedAt = Date.now();

    // Unbounded on purpose: both `continue` paths below are guarded by
    // `attempt + 1 < maxAttempts`, so the final attempt always returns or throws.
    for (let attempt = 0; ; attempt += 1) {
      await this.#rateLimit.acquire();
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        request.timeoutMs ?? this.#config.requestTimeoutMs,
      );
      try {
        const response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: this.#config.apiToken,
            Accept: 'application/json',
            ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: controller.signal,
        });
        this.#rateLimit.observe(response.headers);
        const payload = await parseResponse(response);
        if (response.ok) {
          this.#logger.info('clickup.http', {
            method,
            version,
            path: request.path,
            status: response.status,
            duration_ms: Date.now() - startedAt,
            attempt: attempt + 1,
          });
          return payload as T;
        }

        const error = upstreamError(response, payload);
        if (error.retryable && attempt + 1 < maxAttempts) {
          const waitMs = this.#rateLimit.retryDelay(response.headers, attempt);
          this.#logger.warn('clickup.retry', {
            method,
            version,
            path: request.path,
            status: response.status,
            wait_ms: waitMs,
            attempt: attempt + 1,
          });
          await delay(waitMs);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof ClickUpApiError) throw error;
        const retryable = method === 'GET' && attempt + 1 < maxAttempts;
        if (retryable) {
          await delay(Math.min(4_000, 250 * 2 ** attempt));
          continue;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ToolFailure('CLICKUP_TIMEOUT', 'The ClickUp API request timed out.', method === 'GET');
        }
        throw new ToolFailure('CLICKUP_NETWORK_ERROR', 'Could not reach the ClickUp API.', method === 'GET');
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async getAuthorizedUser(): Promise<Record<string, unknown>> {
    const response = asRecord(await this.request({ path: '/user' }), 'authorized user response');
    return asRecord(response.user, 'authorized user');
  }

  async getAuthorizedWorkspaces(): Promise<AuthorizedWorkspace[]> {
    const response = asRecord(await this.request({ path: '/team' }), 'authorized workspaces response');
    return asArray(response.teams).flatMap((candidate) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const workspace = candidate as Record<string, unknown>;
      const id = stringId(workspace.id);
      if (id === undefined) return [];
      return [
        {
          id,
          ...(typeof workspace.name === 'string' ? { name: workspace.name } : {}),
          members: asArray(workspace.members),
          raw: workspace,
        },
      ];
    });
  }

  async validateAuthentication(): Promise<{ userId?: string; workspaceIds: string[] }> {
    const [user, workspaces] = await Promise.all([
      this.getAuthorizedUser(),
      this.getAuthorizedWorkspaces(),
    ]);
    const workspaceIds = workspaces.map(({ id }) => id);
    if (
      this.#config.defaultWorkspaceId !== undefined &&
      !workspaceIds.includes(this.#config.defaultWorkspaceId)
    ) {
      throw new ToolFailure(
        'WORKSPACE_NOT_AUTHORIZED',
        'CLICKUP_DEFAULT_WORKSPACE_ID is not authorized for this token.',
        false,
      );
    }
    const userId = stringId(user.id);
    return { ...(userId === undefined ? {} : { userId }), workspaceIds };
  }
}
