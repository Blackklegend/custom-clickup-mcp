import { ToolFailure } from './errors.js';

export type ToolProfile = 'core' | 'full';

export interface AppConfig {
  apiToken: string;
  defaultWorkspaceId?: string;
  toolProfile: ToolProfile;
  enableDestructive: boolean;
  enableBulkWrites: boolean;
  bulkMaxItems: number;
  searchMaxPages: number;
  requestTimeoutMs: number;
}

function readToolProfile(env: NodeJS.ProcessEnv): ToolProfile {
  const value = readOptional(env, 'CLICKUP_TOOL_PROFILE') ?? 'full';
  if (value === 'core' || value === 'full') return value;
  throw new ToolFailure(
    'CONFIG_INVALID',
    'CLICKUP_TOOL_PROFILE must be "core" or "full".',
    false,
  );
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = readOptional(env, name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ToolFailure('CONFIG_INVALID', `${name} must be "true" or "false".`, false);
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = readOptional(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ToolFailure(
      'CONFIG_INVALID',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
      false,
    );
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiToken = readOptional(env, 'CLICKUP_API_TOKEN');
  if (apiToken === undefined) {
    throw new ToolFailure(
      'CONFIG_MISSING',
      'CLICKUP_API_TOKEN is required. Provide a ClickUp personal API token through the environment.',
      false,
    );
  }

  const defaultWorkspaceId = readOptional(env, 'CLICKUP_DEFAULT_WORKSPACE_ID');
  return {
    apiToken,
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    toolProfile: readToolProfile(env),
    enableDestructive: readBoolean(env, 'CLICKUP_ENABLE_DESTRUCTIVE', false),
    enableBulkWrites: readBoolean(env, 'CLICKUP_ENABLE_BULK_WRITES', false),
    bulkMaxItems: readInteger(env, 'CLICKUP_BULK_MAX_ITEMS', 25, 1, 100),
    searchMaxPages: readInteger(env, 'CLICKUP_SEARCH_MAX_PAGES', 5, 1, 20),
    requestTimeoutMs: readInteger(env, 'CLICKUP_REQUEST_TIMEOUT_MS', 15_000, 1_000, 120_000),
  };
}
