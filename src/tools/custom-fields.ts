import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { asArray, asRecord, stringId, stringValue } from '../utils/json.js';
import { IdSchema, readOnlyAnnotations, registerClickUpTool, taskQuery } from './shared.js';
import type { ToolDependencies } from './types.js';

const GetCustomFieldsSchema = z
  .object({
    location_type: z.enum(['task', 'list', 'folder', 'space', 'workspace']),
    location_id: IdSchema,
    custom_task_ids: z.boolean().optional().default(false),
    workspace_id: IdSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.location_type !== 'task' && input.custom_task_ids) {
      context.addIssue({
        code: 'custom',
        path: ['custom_task_ids'],
        message: 'custom_task_ids is only valid when location_type is task.',
      });
    }
  });

function fieldOptions(field: Record<string, unknown>): unknown[] {
  if (field.type_config === undefined) return [];
  return asArray(asRecord(field.type_config, 'custom field type_config').options);
}

function fieldAppliesToTask(field: Record<string, unknown>, customItemId: string): boolean {
  const scopes = asArray(field.applied_objects).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const objectType = stringId(record.object_type);
    if (objectType !== '19' && objectType !== 'custom_task_type' && objectType !== 'task_type') {
      return [];
    }
    const objectId = stringId(record.object_id) ?? stringId(record.custom_item_id);
    return objectId === undefined ? [] : [objectId];
  });
  return scopes.length === 0 || scopes.includes(customItemId);
}

function normalizedField(field: Record<string, unknown>): Record<string, unknown> {
  const options = fieldOptions(field);
  return {
    ...field,
    id: stringId(field.id) ?? field.id,
    name: stringValue(field.name) ?? field.name,
    type: stringValue(field.type) ?? field.type,
    options,
  };
}

export function registerCustomFieldTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'get_custom_fields',
    title: 'Get Custom Fields',
    description: 'Discover Custom Field IDs, types, applicability, and option UUIDs at a task or hierarchy location.',
    inputSchema: GetCustomFieldsSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      let endpointType = input.location_type;
      let endpointId = input.location_id;
      let customItemId: string | undefined;
      let task: Record<string, unknown> | undefined;

      if (input.location_type === 'task') {
        task = asRecord(
          await dependencies.client.request({
            path: `/task/${encodeURIComponent(input.location_id)}`,
            query: taskQuery(dependencies, input),
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
        endpointType = 'list';
        endpointId = listId;
        customItemId = task.custom_item_id === null ? '0' : stringId(task.custom_item_id) ?? '0';
      }

      const pathType = endpointType === 'workspace' ? 'team' : endpointType;
      const response = asRecord(
        await dependencies.client.request({
          path: `/${pathType}/${encodeURIComponent(endpointId)}/field`,
          query: { include_applied_objects: true },
        }),
        'custom fields response',
      );
      const allFields = asArray(response.fields).flatMap((candidate) =>
        candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
          ? [candidate as Record<string, unknown>]
          : [],
      );
      const fields = (
        customItemId === undefined
          ? allFields
          : allFields.filter((field) => fieldAppliesToTask(field, customItemId))
      ).map(normalizedField);

      return {
        data: {
          requested_location: { type: input.location_type, id: input.location_id },
          queried_location: { type: endpointType, id: endpointId },
          ...(customItemId === undefined ? {} : { custom_item_id: customItemId }),
          count: fields.length,
          fields,
        },
        summary: `Retrieved ${fields.length} Custom Field definition(s).`,
      };
    },
  });
}
