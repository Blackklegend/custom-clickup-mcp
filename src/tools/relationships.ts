import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import {
  IdSchema,
  additiveAnnotations,
  mutatingAnnotations,
  registerClickUpTool,
  taskQuery,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const RelationshipFields = {
  task_id: IdSchema,
  related_task_id: IdSchema,
  custom_task_ids: z.boolean().optional().default(false),
  workspace_id: IdSchema.optional(),
} as const;
const TaskLinkSchema = z.object(RelationshipFields).strict();
const DependencySchema = z
  .object({ ...RelationshipFields, direction: z.enum(['waiting_on', 'blocking']) })
  .strict();

function ensureDifferentTasks(taskId: string, relatedTaskId: string): void {
  if (taskId === relatedTaskId) {
    throw new ToolFailure(
      'SELF_RELATIONSHIP',
      'A Task cannot be linked to or depend on itself.',
      false,
    );
  }
}

function dependencyParameter(
  direction: 'waiting_on' | 'blocking',
  relatedTaskId: string,
): { depends_on: string } | { dependency_of: string } {
  return direction === 'waiting_on'
    ? { depends_on: relatedTaskId }
    : { dependency_of: relatedTaskId };
}

export function registerRelationshipTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'add_task_link',
    title: 'Add Task Link',
    description: 'Create a bidirectional ClickUp Task Link between two different Tasks.',
    inputSchema: TaskLinkSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      ensureDifferentTasks(input.task_id, input.related_task_id);
      const response = await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/link/${encodeURIComponent(input.related_task_id)}`,
        method: 'POST',
        query: taskQuery(dependencies, input),
      });
      return {
        data: {
          task_id: input.task_id,
          related_task_id: input.related_task_id,
          action: 'linked',
          response,
        },
        summary: `Linked Tasks ${input.task_id} and ${input.related_task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'remove_task_link',
    title: 'Remove Task Link',
    description: 'Remove the ClickUp Task Link between two different Tasks.',
    inputSchema: TaskLinkSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      ensureDifferentTasks(input.task_id, input.related_task_id);
      const response = await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/link/${encodeURIComponent(input.related_task_id)}`,
        method: 'DELETE',
        query: taskQuery(dependencies, input),
      });
      return {
        data: {
          task_id: input.task_id,
          related_task_id: input.related_task_id,
          action: 'unlinked',
          response,
        },
        summary: `Removed the link between Tasks ${input.task_id} and ${input.related_task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'add_dependency',
    title: 'Add Dependency',
    description: 'Create an explicit waiting-on or blocking dependency between two ClickUp Tasks.',
    inputSchema: DependencySchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      ensureDifferentTasks(input.task_id, input.related_task_id);
      await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/dependency`,
        method: 'POST',
        query: taskQuery(dependencies, input),
        body: dependencyParameter(input.direction, input.related_task_id),
      });
      return {
        data: {
          task_id: input.task_id,
          related_task_id: input.related_task_id,
          direction: input.direction,
          action: 'added',
        },
        summary: `Added a ${input.direction} dependency from Task ${input.task_id} to ${input.related_task_id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'remove_dependency',
    title: 'Remove Dependency',
    description: 'Remove an explicit waiting-on or blocking dependency between two ClickUp Tasks.',
    inputSchema: DependencySchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      ensureDifferentTasks(input.task_id, input.related_task_id);
      await dependencies.client.request({
        path: `/task/${encodeURIComponent(input.task_id)}/dependency`,
        method: 'DELETE',
        query: {
          ...taskQuery(dependencies, input),
          ...dependencyParameter(input.direction, input.related_task_id),
        },
      });
      return {
        data: {
          task_id: input.task_id,
          related_task_id: input.related_task_id,
          direction: input.direction,
          action: 'removed',
        },
        summary: `Removed the ${input.direction} dependency from Task ${input.task_id} to ${input.related_task_id}.`,
      };
    },
  });
}
