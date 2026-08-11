import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { normalizeError } from '../errors.js';
import { isRecord } from '../utils/json.js';
import type { ToolDependencies } from './types.js';

export const IdSchema = z.string().trim().min(1).max(256);
export const NumericIdSchema = IdSchema.regex(/^\d+$/, 'Expected a numeric ClickUp ID.');

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
  dependencies: Pick<ToolDependencies, 'logger' | 'ensureAuthenticated'>,
  definition: ToolDefinition<InputSchema>,
): void {
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

  server.registerTool<typeof ToolEnvelopeSchema, InputSchema>(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: ToolEnvelopeSchema,
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
