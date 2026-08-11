import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  IdSchema,
  additiveAnnotations,
  mutatingAnnotations,
  registerClickUpTool,
  taskQuery,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const TagMutationSchema = z
  .object({
    task_id: IdSchema,
    tag_name: z.string().trim().min(1).max(255),
    custom_task_ids: z.boolean().optional().default(false),
    workspace_id: IdSchema.optional(),
  })
  .strict();

export function registerTagTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'add_tag_to_task',
    title: 'Add Tag to Task',
    description: 'Apply an existing ClickUp Tag to a Task.',
    inputSchema: TagMutationSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/tag/${encodeURIComponent(input.tag_name)}`,
        method: 'POST',
        query: taskQuery(dependencies, input),
      });
      return {
        data: { task_id: input.task_id, tag_name: input.tag_name, action: 'added' },
        summary: `Added Tag ${input.tag_name} to Task ${input.task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'remove_tag_from_task',
    title: 'Remove Tag from Task',
    description: 'Remove a ClickUp Tag from a Task without deleting the Tag itself.',
    inputSchema: TagMutationSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/tag/${encodeURIComponent(input.tag_name)}`,
        method: 'DELETE',
        query: taskQuery(dependencies, input),
      });
      return {
        data: { task_id: input.task_id, tag_name: input.tag_name, action: 'removed' },
        summary: `Removed Tag ${input.tag_name} from Task ${input.task_id}.`,
      };
    },
  });
}
