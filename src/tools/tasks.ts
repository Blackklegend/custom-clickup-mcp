import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure, normalizeError } from '../errors.js';
import { asArray, asRecord, stringId, stringValue } from '../utils/json.js';
import {
  IdSchema,
  NumericIdSchema,
  additiveAnnotations,
  mapConcurrent,
  mutatingAnnotations,
  readOnlyAnnotations,
  registerClickUpTool,
  taskQuery,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const PrioritySchema = z.enum(['1', '2', '3', '4']);
const DateTimeSchema = z.iso.datetime({ offset: true });

const TaskReferenceShape = {
  task_id: IdSchema,
  custom_task_ids: z.boolean().optional().default(false),
  workspace_id: IdSchema.optional(),
};

const CreateTaskShape = {
  list_id: IdSchema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().optional(),
  markdown_description: z.string().optional(),
  assignees: z.array(NumericIdSchema).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  priority: PrioritySchema.optional(),
  due_date: DateTimeSchema.optional(),
  due_date_time: z.boolean().optional(),
  time_estimate_ms: z.number().int().nonnegative().optional(),
  start_date: DateTimeSchema.optional(),
  start_date_time: z.boolean().optional(),
  notify_all: z.boolean().optional(),
  parent: IdSchema.optional(),
  custom_item_id: NumericIdSchema.optional(),
  check_required_custom_fields: z.boolean().optional(),
};

const CreateTaskInputSchema = z
  .object(CreateTaskShape)
  .strict()
  .superRefine((input, context) => {
    if (input.description !== undefined && input.markdown_description !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Provide description or markdown_description, not both.',
      });
    }
  });

const GetTaskInputSchema = z
  .object({
    ...TaskReferenceShape,
    include_subtasks: z.boolean().optional().default(false),
  })
  .strict();

const AssigneeChangesSchema = z
  .object({
    add: z.array(NumericIdSchema).max(100).optional(),
    rem: z.array(NumericIdSchema).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.add?.length ?? 0) === 0 && (value.rem?.length ?? 0) === 0) {
      context.addIssue({ code: 'custom', message: 'At least one assignee change is required.' });
    }
  });

const UpdateTaskShape = {
  ...TaskReferenceShape,
  name: z.string().trim().min(1).max(2_000).optional(),
  description: z.string().optional(),
  status: z.string().trim().min(1).max(100).optional(),
  priority: PrioritySchema.nullable().optional(),
  due_date: DateTimeSchema.nullable().optional(),
  due_date_time: z.boolean().optional(),
  time_estimate_ms: z.number().int().nonnegative().nullable().optional(),
  start_date: DateTimeSchema.nullable().optional(),
  start_date_time: z.boolean().optional(),
  assignees: AssigneeChangesSchema.optional(),
  archived: z.boolean().optional(),
};

const UPDATE_CONTROL_FIELDS = new Set(['task_id', 'custom_task_ids', 'workspace_id']);

function requireUpdate(input: Record<string, unknown>, context: z.RefinementCtx): void {
  if (!Object.keys(input).some((key) => !UPDATE_CONTROL_FIELDS.has(key))) {
    context.addIssue({ code: 'custom', message: 'At least one task field must be provided.' });
  }
}

const UpdateTaskInputSchema = z
  .object(UpdateTaskShape)
  .strict()
  .superRefine((input, context) => requireUpdate(input, context));

const CustomFieldValueSchema = z
  .object({
    field_id: IdSchema,
    value: z.unknown().optional(),
    unset: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.unset && field.value !== undefined) {
      context.addIssue({ code: 'custom', message: 'An unset field cannot also have a value.' });
    }
    if (!field.unset && field.value === undefined) {
      context.addIssue({ code: 'custom', message: 'A field value is required unless unset is true.' });
    }
  });

const SetTaskCustomFieldsInputSchema = z
  .object({
    ...TaskReferenceShape,
    fields: z.array(CustomFieldValueSchema).min(1).max(100),
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    confirmation_token: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [index, field] of input.fields.entries()) {
      if (seen.has(field.field_id)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'field_id'],
          message: 'Each custom field may be changed only once per call.',
        });
      }
      seen.add(field.field_id);
    }
  });

const DeleteTaskInputSchema = z
  .object({
    ...TaskReferenceShape,
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    confirmation_token: z.string().min(1).optional(),
  })
  .strict();

const CreateBulkTasksInputSchema = z
  .object({
    items: z.array(CreateTaskInputSchema).min(1).max(100),
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    confirmation_token: z.string().min(1).optional(),
  })
  .strict();

const UpdateBulkTasksInputSchema = z
  .object({
    items: z.array(UpdateTaskInputSchema).min(1).max(100),
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
    confirmation_token: z.string().min(1).optional(),
  })
  .strict();

type CreateTaskInput = z.output<typeof CreateTaskInputSchema>;
type UpdateTaskInput = z.output<typeof UpdateTaskInputSchema>;

function timestamp(value: string | null | undefined): number | null | undefined {
  return value === null ? null : value === undefined ? undefined : Date.parse(value);
}

function numericId(value: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new ToolFailure('ID_OUT_OF_RANGE', `Numeric ClickUp ID ${value} is out of range.`, false);
  }
  return converted;
}

function createTaskBody(input: CreateTaskInput): Record<string, unknown> {
  return {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.markdown_description === undefined
      ? {}
      : { markdown_content: input.markdown_description }),
    ...(input.assignees === undefined
      ? {}
      : { assignees: input.assignees.map(numericId) }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined ? {} : { priority: Number(input.priority) }),
    ...(input.due_date === undefined ? {} : { due_date: timestamp(input.due_date) }),
    ...(input.due_date_time === undefined ? {} : { due_date_time: input.due_date_time }),
    ...(input.time_estimate_ms === undefined ? {} : { time_estimate: input.time_estimate_ms }),
    ...(input.start_date === undefined ? {} : { start_date: timestamp(input.start_date) }),
    ...(input.start_date_time === undefined ? {} : { start_date_time: input.start_date_time }),
    ...(input.notify_all === undefined ? {} : { notify_all: input.notify_all }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.custom_item_id === undefined
      ? {}
      : { custom_item_id: numericId(input.custom_item_id) }),
    ...(input.check_required_custom_fields === undefined
      ? {}
      : { check_required_custom_fields: input.check_required_custom_fields }),
  };
}

function updateTaskBody(input: UpdateTaskInput): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined
      ? {}
      : { priority: input.priority === null ? null : Number(input.priority) }),
    ...(input.due_date === undefined ? {} : { due_date: timestamp(input.due_date) }),
    ...(input.due_date_time === undefined ? {} : { due_date_time: input.due_date_time }),
    ...(input.time_estimate_ms === undefined
      ? {}
      : { time_estimate: input.time_estimate_ms }),
    ...(input.start_date === undefined ? {} : { start_date: timestamp(input.start_date) }),
    ...(input.start_date_time === undefined ? {} : { start_date_time: input.start_date_time }),
    ...(input.assignees === undefined
      ? {}
      : {
          assignees: {
            ...(input.assignees.add === undefined
              ? {}
              : { add: input.assignees.add.map(numericId) }),
            ...(input.assignees.rem === undefined
              ? {}
              : { rem: input.assignees.rem.map(numericId) }),
          },
        }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  };
}

async function createTask(dependencies: ToolDependencies, input: CreateTaskInput): Promise<unknown> {
  return dependencies.client.request({
    path: `/list/${encodeURIComponent(input.list_id)}/task`,
    method: 'POST',
    body: createTaskBody(input),
  });
}

async function updateTask(dependencies: ToolDependencies, input: UpdateTaskInput): Promise<unknown> {
  const query = taskQuery(dependencies, input);
  return dependencies.client.request({
    path: `/task/${encodeURIComponent(input.task_id)}`,
    method: 'PUT',
    query,
    body: updateTaskBody(input),
  });
}

function taskLocation(task: Record<string, unknown>): Record<string, unknown> {
  const list = task.list === undefined ? {} : asRecord(task.list, 'task list');
  const folder = task.folder === undefined ? {} : asRecord(task.folder, 'task folder');
  const space = task.space === undefined ? {} : asRecord(task.space, 'task space');
  return {
    ...(stringId(list.id) === undefined ? {} : { list_id: stringId(list.id) }),
    ...(stringValue(list.name) === undefined ? {} : { list_name: stringValue(list.name) }),
    ...(stringId(folder.id) === undefined ? {} : { folder_id: stringId(folder.id) }),
    ...(stringValue(folder.name) === undefined ? {} : { folder_name: stringValue(folder.name) }),
    ...(stringId(space.id) === undefined ? {} : { space_id: stringId(space.id) }),
  };
}

function fieldOptions(field: Record<string, unknown>): Array<Record<string, unknown>> {
  const typeConfig = field.type_config;
  if (typeConfig === undefined) return [];
  return asArray(asRecord(typeConfig, 'custom field type_config').options).flatMap((option) =>
    option !== null && typeof option === 'object' && !Array.isArray(option)
      ? [option as Record<string, unknown>]
      : [],
  );
}

function validateOptionIds(
  field: Record<string, unknown>,
  supplied: unknown,
  multiple: boolean,
): void {
  const values = multiple ? (Array.isArray(supplied) ? supplied : []) : [supplied];
  if (multiple && !Array.isArray(supplied)) {
    throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', 'This custom field expects an array.', false);
  }
  const options = fieldOptions(field);
  const valid = new Set(options.map((option) => stringId(option.id)).filter((id) => id !== undefined));
  const invalid = values.filter((value) => typeof value !== 'string' || !valid.has(value));
  if (invalid.length > 0) {
    throw new ToolFailure(
      'CUSTOM_FIELD_OPTION_INVALID',
      `The value is not a valid option for custom field ${String(field.name ?? field.id)}.`,
      false,
      {
        field_id: stringId(field.id) ?? '',
        candidates: options.map((option) => ({
          id: stringId(option.id),
          name: stringValue(option.name) ?? stringValue(option.label),
        })),
      },
    );
  }
}

function validatedCustomFieldValue(field: Record<string, unknown>, value: unknown): unknown {
  const type = stringValue(field.type);
  if (type === 'drop_down') validateOptionIds(field, value, false);
  if (type === 'labels') validateOptionIds(field, value, true);
  if (type === 'short_text' || type === 'text' || type === 'phone') {
    if (typeof value !== 'string') {
      throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', `${type} fields require a string.`, false);
    }
    if (type === 'phone' && !/^\+[0-9][0-9\s().-]+$/.test(value)) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        'Phone fields require a number with a country code.',
        false,
      );
    }
  }
  if (type === 'url') {
    if (typeof value !== 'string') {
      throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', 'URL fields require a string.', false);
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    } catch {
      throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', 'URL fields require a valid HTTP(S) URL.', false);
    }
  }
  if (
    type === 'email' &&
    (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
  ) {
    throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', 'Email fields require a valid email address.', false);
  }
  if (type === 'checkbox' && typeof value !== 'boolean') {
    throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', 'Checkbox fields require a boolean.', false);
  }
  if ((type === 'number' || type === 'currency') && typeof value !== 'number') {
    throw new ToolFailure('CUSTOM_FIELD_VALUE_INVALID', `${type} fields require a number.`, false);
  }
  if (type === 'date') {
    if (typeof value !== 'string') {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        'Date custom fields require an RFC 3339 string.',
        false,
      );
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d\d:\d\d$/.test(value)) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        'Date custom fields require an RFC 3339 string with timezone.',
        false,
      );
    }
    return parsed;
  }
  if (type === 'tasks' || type === 'users') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        `${type} fields require an object with add and/or rem arrays.`,
        false,
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const hasChange = keys.includes('add') || keys.includes('rem');
    const validKeys = keys.every((key) => key === 'add' || key === 'rem');
    const validArrays = ['add', 'rem'].every(
      (key) => record[key] === undefined || (Array.isArray(record[key]) && record[key].every((id) => typeof id === 'string' && id.length > 0)),
    );
    if (!hasChange || !validKeys || !validArrays) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        `${type} fields require only non-empty string ID arrays in add and/or rem.`,
        false,
      );
    }
  }
  if (type === 'emoji') {
    const count = Number(asRecord(field.type_config, 'custom field type_config').count);
    if (!Number.isInteger(value) || (value as number) < 0 || (Number.isFinite(count) && (value as number) > count)) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        `Emoji fields require an integer between 0 and ${Number.isFinite(count) ? count : 5}.`,
        false,
      );
    }
  }
  if (type === 'manual_progress' || type === 'progress') {
    const config = asRecord(field.type_config, 'custom field type_config');
    if (type === 'progress' && config.method !== 'manual') {
      throw new ToolFailure(
        'CUSTOM_FIELD_TYPE_UNSUPPORTED',
        'Automatic progress fields cannot be set through the API.',
        false,
      );
    }
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
    const current = record?.current;
    const start = typeof config.start === 'number' ? config.start : Number.NEGATIVE_INFINITY;
    const end = typeof config.end === 'number' ? config.end : Number.POSITIVE_INFINITY;
    if (typeof current !== 'number' || !Number.isFinite(current) || current < start || current > end) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        'Manual progress fields require { current } within the configured range.',
        false,
      );
    }
  }
  if (type === 'location') {
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
    const location = record?.location;
    const coordinates = location !== null && typeof location === 'object' && !Array.isArray(location)
      ? (location as Record<string, unknown>)
      : undefined;
    if (
      typeof coordinates?.lat !== 'number' ||
      typeof coordinates.lng !== 'number' ||
      typeof record?.formatted_address !== 'string' ||
      record.formatted_address.length === 0
    ) {
      throw new ToolFailure(
        'CUSTOM_FIELD_VALUE_INVALID',
        'Location fields require location.lat, location.lng, and formatted_address.',
        false,
      );
    }
  }
  const supportedTypes = new Set([
    'url', 'drop_down', 'email', 'phone', 'date', 'short_text', 'text', 'checkbox',
    'number', 'currency', 'tasks', 'users', 'emoji', 'manual_progress', 'progress',
    'labels', 'location',
  ]);
  if (type === undefined || !supportedTypes.has(type)) {
    throw new ToolFailure(
      'CUSTOM_FIELD_TYPE_UNSUPPORTED',
      `Custom field type ${type ?? 'unknown'} is not safely writable by this MCP.`,
      false,
    );
  }
  return value;
}

function fieldAppliesToTask(field: Record<string, unknown>, customItemId: string): boolean {
  const taskTypeScopes = asArray(field.applied_objects).flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const objectType = stringId(record.object_type);
    if (objectType !== '19' && objectType !== 'custom_task_type' && objectType !== 'task_type') {
      return [];
    }
    const objectId = stringId(record.object_id) ?? stringId(record.custom_item_id);
    return objectId === undefined ? [] : [objectId];
  });
  return taskTypeScopes.length === 0 || taskTypeScopes.includes(customItemId);
}

function assertBulkLimit(dependencies: ToolDependencies, count: number): void {
  const limit = Math.min(dependencies.config.bulkMaxItems, 100);
  if (count > limit) {
    throw new ToolFailure(
      'BULK_LIMIT_EXCEEDED',
      `This process allows at most ${limit} items per bulk operation.`,
      false,
      { limit, supplied: count },
    );
  }
}

function requireBulkExecution(
  dependencies: ToolDependencies,
  action: string,
  items: readonly unknown[],
  confirm: boolean,
  confirmationToken: string | undefined,
): void {
  if (!dependencies.config.enableBulkWrites) {
    throw new ToolFailure(
      'BULK_WRITES_DISABLED',
      'Bulk writes require CLICKUP_ENABLE_BULK_WRITES=true.',
      false,
    );
  }
  if (!confirm || confirmationToken === undefined) {
    throw new ToolFailure(
      'CONFIRMATION_REQUIRED',
      'Bulk execution requires confirm=true and the confirmation_token from a preview.',
      false,
    );
  }
  dependencies.confirmations.verifyAndConsume(
    confirmationToken,
    action,
    'bulk',
    { items },
  );
}

function bulkPreview(dependencies: ToolDependencies, action: string, items: readonly unknown[]) {
  return {
    dry_run: true,
    total: items.length,
    items,
    confirmation_token: dependencies.confirmations.create(action, 'bulk', { items }),
    confirmation_expires_in_seconds: 600,
  };
}

async function bulkResults<T>(
  items: readonly T[],
  operation: (item: T) => Promise<unknown>,
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  partial_failure: boolean;
  results: Array<Record<string, unknown>>;
}> {
  const results = await mapConcurrent(items, 3, async (item, index) => {
    try {
      return { index, ok: true, data: await operation(item) };
    } catch (error) {
      const normalized = normalizeError(error);
      return {
        index,
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          ...(normalized.details === undefined ? {} : { details: normalized.details }),
        },
      };
    }
  });
  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  return {
    total: results.length,
    succeeded,
    failed,
    partial_failure: failed > 0 && succeeded > 0,
    results,
  };
}

export const TASK_TOOL_NAMES = [
  'create_task',
  'get_task',
  'update_task',
  'set_task_custom_fields',
  'delete_task',
  'create_bulk_tasks',
  'update_bulk_tasks',
] as const;

export function registerTaskTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'create_task',
    title: 'Create task',
    description: 'Create a task in a ClickUp List.',
    inputSchema: CreateTaskInputSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const task = await createTask(dependencies, input);
      return { data: task, summary: 'Task created.' };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'get_task',
    title: 'Get task',
    description: 'Get one ClickUp task by task ID or Custom Task ID.',
    inputSchema: GetTaskInputSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const task = await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}`,
        query: {
          ...taskQuery(dependencies, input),
          include_subtasks: input.include_subtasks,
        },
      });
      return { data: task, summary: 'Task retrieved.' };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'update_task',
    title: 'Update task',
    description: 'Update only the provided fields of a ClickUp task.',
    inputSchema: UpdateTaskInputSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const task = await updateTask(dependencies, input);
      return { data: task, summary: 'Task updated.' };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'set_task_custom_fields',
    title: 'Set task custom fields',
    description: 'Discover, validate, set, or remove custom field values on a task.',
    inputSchema: SetTaskCustomFieldsInputSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      if (input.fields.length > 1) assertBulkLimit(dependencies, input.fields.length);
      const query = taskQuery(dependencies, input);
      const task = asRecord(
        await dependencies.client.request({
          path: `/task/${encodeURIComponent(input.task_id)}`,
          query,
        }),
        'task',
      );
      const list = asRecord(task.list, 'task list');
      const listId = stringId(list.id);
      if (listId === undefined) {
        throw new ToolFailure(
          'TASK_LIST_MISSING',
          'The task response did not identify its home List.',
          true,
        );
      }
      const response = asRecord(
        await dependencies.client.request({
          path: `/list/${encodeURIComponent(listId)}/field`,
          query: { include_applied_objects: true },
        }),
        'List custom fields',
      );
      const allAvailable = asArray(response.fields).flatMap((candidate) =>
        candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
          ? [candidate as Record<string, unknown>]
          : [],
      );
      const customItemId = task.custom_item_id === null ? '0' : stringId(task.custom_item_id) ?? '0';
      const available = allAvailable.filter((field) => fieldAppliesToTask(field, customItemId));
      const byId = new Map(
        available.flatMap((field) => {
          const id = stringId(field.id);
          return id === undefined ? [] : [[id, field] as const];
        }),
      );

      const prepared = input.fields.map((change) => {
        const field = byId.get(change.field_id);
        if (field === undefined) {
          throw new ToolFailure(
            'CUSTOM_FIELD_NOT_APPLICABLE',
            `Custom field ${change.field_id} is not available on the task's List.`,
            false,
            {
              field_id: change.field_id,
              available_fields: available.map((candidate) => ({
                id: stringId(candidate.id),
                name: stringValue(candidate.name),
                type: stringValue(candidate.type),
              })),
            },
          );
        }
        return {
          ...change,
          value: change.unset ? undefined : validatedCustomFieldValue(field, change.value),
        };
      });

      const hasUnsets = prepared.some(({ unset }) => unset);
      const isBulk = prepared.length > 1;
      const confirmationPayload = {
        task_id: input.task_id,
        custom_task_ids: input.custom_task_ids,
        ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
        fields: input.fields,
      };
      if (input.dry_run) {
        return {
          data: {
            dry_run: true,
            task_id: input.task_id,
            list_id: listId,
            custom_item_id: customItemId,
            changes: prepared.map(({ field_id: fieldId, unset }) => ({ field_id: fieldId, unset })),
            destructive_writes_enabled: dependencies.config.enableDestructive,
            bulk_writes_enabled: dependencies.config.enableBulkWrites,
            confirmation_token: dependencies.confirmations.create(
              'set_task_custom_fields',
              input.task_id,
              confirmationPayload,
            ),
            confirmation_expires_in_seconds: 600,
          },
          summary: `Custom field preview generated for ${prepared.length} value(s); no values were changed.`,
        };
      }
      if (hasUnsets && !dependencies.config.enableDestructive) {
        throw new ToolFailure(
          'DESTRUCTIVE_WRITES_DISABLED',
          'Removing custom field values requires CLICKUP_ENABLE_DESTRUCTIVE=true.',
          false,
        );
      }
      if (isBulk && !dependencies.config.enableBulkWrites) {
        throw new ToolFailure(
          'BULK_WRITES_DISABLED',
          'Changing multiple custom fields requires CLICKUP_ENABLE_BULK_WRITES=true.',
          false,
        );
      }
      if (hasUnsets || isBulk) {
        if (!input.confirm || input.confirmation_token === undefined) {
          throw new ToolFailure(
            'CONFIRMATION_REQUIRED',
            'Destructive or multi-field execution requires confirm=true and the confirmation_token from a preview.',
            false,
          );
        }
        dependencies.confirmations.verifyAndConsume(
          input.confirmation_token,
          'set_task_custom_fields',
          input.task_id,
          confirmationPayload,
        );
      }

      const applyChange = async (change: (typeof prepared)[number]): Promise<unknown> => {
        const result = await dependencies.client.request({
          path: `/task/${encodeURIComponent(input.task_id)}/field/${encodeURIComponent(change.field_id)}`,
          method: change.unset ? 'DELETE' : 'POST',
          query,
          ...(change.unset ? {} : { body: { value: change.value } }),
        });
        return { field_id: change.field_id, unset: change.unset, response: result };
      };
      if (!isBulk) {
        const result = await applyChange(prepared[0]!);
        return {
          data: {
            task_id: input.task_id,
            list_id: listId,
            updated: 1,
            failed: 0,
            partial_failure: false,
            results: [{ index: 0, ok: true, data: result }],
          },
          summary: '1 custom field value updated.',
        };
      }
      const mutationResult = await bulkResults(prepared, applyChange);
      return {
        data: {
          task_id: input.task_id,
          list_id: listId,
          updated: mutationResult.succeeded,
          failed: mutationResult.failed,
          partial_failure: mutationResult.partial_failure,
          results: mutationResult.results,
        },
        summary: `Custom field update finished: ${mutationResult.succeeded} succeeded, ${mutationResult.failed} failed.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'delete_task',
    title: 'Delete task',
    description: 'Preview or explicitly confirm permanent deletion of a ClickUp task.',
    inputSchema: DeleteTaskInputSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const payload = {
        task_id: input.task_id,
        custom_task_ids: input.custom_task_ids,
        ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
      };
      const query = taskQuery(dependencies, input);
      if (input.dry_run) {
        const task = asRecord(
          await dependencies.client.request({
            path: `/task/${encodeURIComponent(input.task_id)}`,
            query,
          }),
          'task',
        );
        return {
          data: {
            dry_run: true,
            task: {
              id: stringId(task.id) ?? input.task_id,
              name: stringValue(task.name),
              location: taskLocation(task),
            },
            destructive_writes_enabled: dependencies.config.enableDestructive,
            confirmation_token: dependencies.confirmations.create(
              'delete_task',
              input.task_id,
              payload,
            ),
            confirmation_expires_in_seconds: 600,
          },
          summary: 'Task deletion preview generated; no task was deleted.',
        };
      }
      if (!dependencies.config.enableDestructive) {
        throw new ToolFailure(
          'DESTRUCTIVE_WRITES_DISABLED',
          'Task deletion requires CLICKUP_ENABLE_DESTRUCTIVE=true.',
          false,
        );
      }
      if (!input.confirm || input.confirmation_token === undefined) {
        throw new ToolFailure(
          'CONFIRMATION_REQUIRED',
          'Task deletion requires confirm=true and the confirmation_token from a preview.',
          false,
        );
      }
      dependencies.confirmations.verifyAndConsume(
        input.confirmation_token,
        'delete_task',
        input.task_id,
        payload,
      );
      await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}`,
        method: 'DELETE',
        query,
      });
      return {
        data: { deleted: true, task_id: input.task_id },
        summary: 'Task deleted.',
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_bulk_tasks',
    title: 'Create tasks in bulk',
    description: 'Preview or create multiple tasks with bounded concurrency and per-item results.',
    inputSchema: CreateBulkTasksInputSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      assertBulkLimit(dependencies, input.items.length);
      if (input.dry_run) {
        return {
          data: bulkPreview(dependencies, 'create_bulk_tasks', input.items),
          summary: `Bulk create preview generated for ${input.items.length} task(s).`,
        };
      }
      requireBulkExecution(
        dependencies,
        'create_bulk_tasks',
        input.items,
        input.confirm,
        input.confirmation_token,
      );
      const data = await bulkResults(input.items, async (item) => createTask(dependencies, item));
      return { data, summary: `Bulk create finished: ${data.succeeded} succeeded, ${data.failed} failed.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'update_bulk_tasks',
    title: 'Update tasks in bulk',
    description: 'Preview or update multiple tasks with bounded concurrency and per-item results.',
    inputSchema: UpdateBulkTasksInputSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      assertBulkLimit(dependencies, input.items.length);
      if (input.dry_run) {
        return {
          data: bulkPreview(dependencies, 'update_bulk_tasks', input.items),
          summary: `Bulk update preview generated for ${input.items.length} task(s).`,
        };
      }
      requireBulkExecution(
        dependencies,
        'update_bulk_tasks',
        input.items,
        input.confirm,
        input.confirmation_token,
      );
      const data = await bulkResults(input.items, async (item) => updateTask(dependencies, item));
      return { data, summary: `Bulk update finished: ${data.succeeded} succeeded, ${data.failed} failed.` };
    },
  });
}
