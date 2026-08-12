import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure, normalizeError } from '../errors.js';
import { asArray, asRecord, isRecord, stringId, stringValue } from '../utils/json.js';
import { normalizeSearchText } from '../utils/text.js';
import { toolIsEnabled } from './catalog.js';
import type { ToolDependencies } from './types.js';

export const IdSchema = z.string().trim().min(1).max(256);
export const NumericIdSchema = IdSchema.regex(/^\d+$/, 'Expected a numeric ClickUp ID.');
const StrictDateTimeSchema = z.iso.datetime({ offset: true });
// Zod's ISO helper advertises a long validation regex in every containing JSON Schema.
// Keep that strict runtime check but expose the standard `date-time` format to MCP clients.
export const DateTimeSchema = z
  .string()
  .refine((value) => StrictDateTimeSchema.safeParse(value).success, {
    message: 'Expected an RFC 3339 date-time with timezone.',
  })
  .meta({ format: 'date-time' });

/**
 * Query parameters that let a ClickUp endpoint resolve a Custom Task ID. Returns an
 * empty object when the caller passed a plain Task ID, so call sites can spread it
 * unconditionally.
 */
export function taskQuery(
  dependencies: Pick<ToolDependencies, 'client'>,
  input: { custom_task_ids: boolean; workspace_id?: string | undefined },
): Record<string, string | boolean> {
  if (!input.custom_task_ids) return {};
  return {
    custom_task_ids: true,
    team_id: dependencies.client.requireWorkspaceId(input.workspace_id),
  };
}

export type TaskType = { id: string; name?: string };

// ClickUp serves these two from every Workspace but omits them from `/custom_item`.
const BUILT_IN_TASK_TYPES: readonly TaskType[] = [
  { id: '0', name: 'Task' },
  { id: '1', name: 'Milestone' },
];

async function fetchTaskTypeCandidates(
  dependencies: Pick<ToolDependencies, 'client'>,
  workspaceId: string,
): Promise<TaskType[]> {
  const response = asRecord(
    await dependencies.client.request({
      path: `/team/${encodeURIComponent(workspaceId)}/custom_item`,
    }),
    'custom task types response',
  );
  const customCandidates = asArray(response.custom_items ?? response.custom_item_types).flatMap(
    (value) => {
      if (!isRecord(value)) return [];
      const id = stringId(value.id);
      if (id === undefined) return [];
      const name = stringValue(value.name);
      return [{ id, ...(name === undefined ? {} : { name }) }];
    },
  );
  return [
    ...BUILT_IN_TASK_TYPES,
    ...customCandidates.filter(({ id }) => id !== '0' && id !== '1'),
  ];
}

function matchTaskType(candidates: readonly TaskType[], requestedType: string): TaskType {
  const normalized = normalizeSearchText(requestedType);
  const matches = candidates.filter(
    (candidate) =>
      normalizeSearchText(candidate.id) === normalized ||
      (candidate.name !== undefined && normalizeSearchText(candidate.name) === normalized),
  );
  if (matches.length === 0) {
    throw new ToolFailure('TASK_TYPE_NOT_FOUND', `No task type matched ${requestedType}.`, false, {
      candidates,
    });
  }
  if (matches.length > 1 || matches[0] === undefined) {
    throw new ToolFailure(
      'TASK_TYPE_AMBIGUOUS',
      `More than one task type matched ${requestedType}.`,
      false,
      { candidates: matches },
    );
  }
  return matches[0];
}

export interface TaskTypeResolver {
  resolveMany(workspaceId: string, requestedTypes: readonly string[]): Promise<TaskType[]>;
  resolveOne(workspaceId: string, requestedType: string): Promise<TaskType>;
}

/**
 * Resolves task types supplied either as a ClickUp `custom_item_id` or as a display name
 * such as `Bug`. The candidate list is fetched at most once per Workspace per resolver, so
 * a bulk call costs one lookup instead of one per item.
 */
export function createTaskTypeResolver(
  dependencies: Pick<ToolDependencies, 'client'>,
): TaskTypeResolver {
  const candidatesByWorkspace = new Map<string, Promise<TaskType[]>>();
  const candidatesFor = async (workspaceId: string): Promise<TaskType[]> => {
    const cached = candidatesByWorkspace.get(workspaceId);
    if (cached !== undefined) return cached;
    const pending = fetchTaskTypeCandidates(dependencies, workspaceId);
    candidatesByWorkspace.set(workspaceId, pending);
    return pending;
  };
  const resolveMany = async (
    workspaceId: string,
    requestedTypes: readonly string[],
  ): Promise<TaskType[]> => {
    const candidates = await candidatesFor(workspaceId);
    return requestedTypes.map((requestedType) => matchTaskType(candidates, requestedType));
  };
  return {
    resolveMany,
    async resolveOne(workspaceId: string, requestedType: string): Promise<TaskType> {
      const [taskType] = await resolveMany(workspaceId, [requestedType]);
      if (taskType === undefined) {
        throw new ToolFailure(
          'TASK_TYPE_NOT_FOUND',
          `No task type matched ${requestedType}.`,
          false,
        );
      }
      return taskType;
    },
  };
}

export async function resolveTaskTypes(
  dependencies: Pick<ToolDependencies, 'client'>,
  workspaceId: string,
  requestedTypes: readonly string[],
): Promise<TaskType[]> {
  return createTaskTypeResolver(dependencies).resolveMany(workspaceId, requestedTypes);
}

export async function resolveTaskType(
  dependencies: Pick<ToolDependencies, 'client'>,
  workspaceId: string,
  requestedType: string,
): Promise<TaskType> {
  return createTaskTypeResolver(dependencies).resolveOne(workspaceId, requestedType);
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

const ToolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ToolEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: ToolErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && (value.data === undefined || value.error !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful tool results require data and cannot include error.',
      });
    }
    if (!value.ok && (value.error === undefined || value.data !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Failed tool results require error and cannot include data.',
      });
    }
  });

type ToolEnvelope = z.output<typeof ToolEnvelopeSchema>;
type EnvelopeCallToolResult = CallToolResult & { structuredContent: ToolEnvelope };

export interface HandlerOutput {
  data: unknown;
  summary: string;
}

export interface ToolDefinition<
  InputSchema extends StandardSchemaWithJSON & z.ZodType,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  handler(input: StandardSchemaWithJSON.InferOutput<InputSchema>): Promise<HandlerOutput>;
}

function errorResult(error: unknown): EnvelopeCallToolResult {
  const normalized = normalizeError(error);
  const structuredContent = ToolEnvelopeSchema.parse({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  });
  return {
    isError: true,
    content: [{ type: 'text', text: `${normalized.code}: ${normalized.message}` }],
    structuredContent,
  };
}

export function registerClickUpTool<
  InputSchema extends StandardSchemaWithJSON & z.ZodType,
>(
  server: McpServer,
  dependencies: Pick<ToolDependencies, 'logger' | 'ensureAuthenticated'> & {
    config?: Pick<ToolDependencies['config'], 'toolProfile'>;
  },
  definition: ToolDefinition<InputSchema>,
): void {
  if (!toolIsEnabled(dependencies.config?.toolProfile ?? 'full', definition.name)) return;

  const callback = (async (
    input: StandardSchemaWithJSON.InferOutput<InputSchema>,
  ): Promise<CallToolResult> => {
    const startedAt = Date.now();
    try {
      const parsedInput = definition.inputSchema.parse(
        input,
      ) as StandardSchemaWithJSON.InferOutput<InputSchema>;
      await dependencies.ensureAuthenticated?.();
      const output = await definition.handler(parsedInput);
      dependencies.logger.info('mcp.tool', {
        tool: definition.name,
        ok: true,
        duration_ms: Date.now() - startedAt,
      });
      // The write has already reached ClickUp by now, so an unexpected payload shape must
      // never turn a succeeded call into a reported failure: wrap it instead of throwing.
      const result: EnvelopeCallToolResult = {
        content: [{ type: 'text', text: output.summary }],
        structuredContent: ToolEnvelopeSchema.parse({
          ok: true,
          data: isRecord(output.data) ? output.data : { value: output.data },
        }),
      };
      return result;
    } catch (error) {
      const normalized = normalizeError(error);
      dependencies.logger.error('mcp.tool', {
        tool: definition.name,
        ok: false,
        code: normalized.code,
        retryable: normalized.retryable,
        duration_ms: Date.now() - startedAt,
      });
      return errorResult(normalized);
    }
  }) as unknown as ToolCallback<InputSchema>;

  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    },
    callback,
  );
}

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const additiveAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const mutatingAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
