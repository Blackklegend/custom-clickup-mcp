import type { McpServer } from '@modelcontextprotocol/server';

import { registerCommentTools } from './comments.js';
import { registerMemberTools } from './members.js';
import { registerMoveTools } from './move.js';
import { registerRelationshipTools } from './relationships.js';
import { registerSearchTools } from './search.js';
import { registerTagTools } from './tags.js';
import { registerTaskTools } from './tasks.js';
import type { ToolDependencies } from './types.js';
import { registerWorkspaceTools } from './workspace.js';

export const TOOL_NAMES = [
  'search_workspace',
  'search_tasks_by_task_type',
  'search_tasks_by_tag',
  'create_task',
  'get_task',
  'update_task',
  'set_task_custom_fields',
  'delete_task',
  'create_bulk_tasks',
  'update_bulk_tasks',
  'get_task_comments',
  'get_threaded_replies',
  'create_task_comment',
  'add_tag_to_task',
  'remove_tag_from_task',
  'add_task_link',
  'remove_task_link',
  'add_dependency',
  'remove_dependency',
  'move_task_to_list',
  'add_task_to_list',
  'get_workspace_hierarchy',
  'create_list_in_space',
  'create_list_in_folder',
  'get_list',
  'update_list',
  'get_folder',
  'create_folder',
  'update_folder',
  'get_workspace_members',
  'find_member_by_name',
  'resolve_assignees',
] as const;

export function registerAllTools(server: McpServer, dependencies: ToolDependencies): void {
  registerSearchTools(server, dependencies);
  registerTaskTools(server, dependencies);
  registerCommentTools(server, dependencies);
  registerTagTools(server, dependencies);
  registerRelationshipTools(server, dependencies);
  registerMoveTools(server, dependencies);
  registerWorkspaceTools(server, dependencies);
  registerMemberTools(server, dependencies);
}
