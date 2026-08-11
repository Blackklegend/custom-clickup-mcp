import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { asRecord, stringId } from '../utils/json.js';
import {
  IdSchema,
  additiveAnnotations,
  mutatingAnnotations,
  registerClickUpTool,
} from './shared.js';
import type { ToolDependencies } from './types.js';

/**
 * ClickUp's own docs contradict each other here. The narrative guide shows
 * `source_status`/`destination_status`:
 *   https://developer.clickup.com/docs/move-a-task-to-a-new-list
 * The OpenAPI reference (TaskSingleStatusMappingDto) requires the `_id` suffix:
 *   https://developer.clickup.com/reference/movetask
 *
 * The API agrees with the reference. Verified against the live v3 endpoint with
 * everything but the key naming held constant: `source_status_id` returns 200,
 * `source_status` returns 400 "Invalid status mappings". Do not "fix" this to
 * match the guide page.
 */
const StatusMappingSchema = z
  .object({ source_status_id: IdSchema, destination_status_id: IdSchema })
  .strict();
const MoveTaskSchema = z
  .object({
    workspace_id: IdSchema.optional(),
    task_id: IdSchema,
    list_id: IdSchema,
    move_custom_fields: z.boolean().optional(),
    custom_fields_to_move: z.array(IdSchema).max(100).optional(),
    status_mappings: z.array(StatusMappingSchema).max(100).optional(),
  })
  .strict();
const AddTaskToListSchema = z.object({ task_id: IdSchema, list_id: IdSchema }).strict();

function currentHomeListId(task: unknown): string | undefined {
  const taskRecord = asRecord(task, 'task response');
  const list = taskRecord.list;
  if (list === null || typeof list !== 'object' || Array.isArray(list)) return undefined;
  return stringId((list as Record<string, unknown>).id);
}

async function getTaskHomeList(
  dependencies: ToolDependencies,
  taskId: string,
): Promise<string | undefined> {
  return currentHomeListId(
    await dependencies.client.request({ path: `/task/${encodeURIComponent(taskId)}` }),
  );
}

export function registerMoveTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'move_task_to_list',
    title: 'Move Task to List',
    description: 'Move a ClickUp Task to a new home List using the v3 API.',
    inputSchema: MoveTaskSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const previousListId = await getTaskHomeList(dependencies, input.task_id);
      const body = {
        ...(input.move_custom_fields === undefined
          ? {}
          : { move_custom_fields: input.move_custom_fields }),
        ...(input.custom_fields_to_move === undefined
          ? {}
          : { custom_fields_to_move: input.custom_fields_to_move }),
        ...(input.status_mappings === undefined ? {} : { status_mappings: input.status_mappings }),
      };
      const response = await dependencies.client.request({
        version: 'v3',
        path: `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(input.task_id)}/home_list/${encodeURIComponent(input.list_id)}`,
        method: 'PUT',
        body,
      });
      return {
        data: {
          task_id: input.task_id,
          previous_list_id: previousListId ?? null,
          new_list_id: input.list_id,
          response,
        },
        summary: `Moved Task ${input.task_id} to home List ${input.list_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'add_task_to_list',
    title: 'Add Task to List',
    description: 'Add a Task to an additional List while preserving its home List.',
    inputSchema: AddTaskToListSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const homeListId = await getTaskHomeList(dependencies, input.task_id);
      await dependencies.client.request({
        path: `/list/${encodeURIComponent(input.list_id)}/task/${encodeURIComponent(input.task_id)}`,
        method: 'POST',
      });
      return {
        data: {
          task_id: input.task_id,
          home_list_id: homeListId ?? null,
          added_list_id: input.list_id,
          home_list_preserved: true,
        },
        summary: `Added Task ${input.task_id} to additional List ${input.list_id}.`,
      };
    },
  });
}
