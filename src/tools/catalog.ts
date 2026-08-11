import type { ToolProfile } from '../config.js';

/**
 * The compact catalog covers the common task workflow while leaving administrative,
 * relationship, move, delete, bulk, and member-discovery tools available in `full`.
 */
export const CORE_TOOL_NAMES = [
  'search_workspace',
  'search_tasks_by_task_type',
  'search_tasks_by_tag',
  'create_task',
  'get_task',
  'update_task',
  'set_task_custom_fields',
  'get_task_comments',
  'get_threaded_replies',
  'create_task_comment',
  'add_tag_to_task',
  'remove_tag_from_task',
  'get_workspace_hierarchy',
  'resolve_assignees',
] as const;

const CORE_TOOLS = new Set<string>(CORE_TOOL_NAMES);

export function toolIsEnabled(profile: ToolProfile, toolName: string): boolean {
  return profile === 'full' || CORE_TOOLS.has(toolName);
}
