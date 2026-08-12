import type { McpServer } from '@modelcontextprotocol/server';

import { registerAttachmentTools } from './attachments.js';
import { registerCommentTools } from './comments.js';
import { registerCustomFieldTools } from './custom-fields.js';
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
  'filter_tasks',
  'create_task',
  'get_task',
  'update_task',
  'set_task_custom_fields',
  'delete_task',
  'merge_tasks',
  'create_bulk_tasks',
  'update_bulk_tasks',
  'request_attachment_upload',
  'attach_task_file',
  'download_task_attachment',
  'get_custom_fields',
  'get_task_comments',
  'get_threaded_replies',
  'create_comment',
  'create_task_comment',
  'update_comment',
  'delete_comment',
  'add_tag_to_task',
  'remove_tag_from_task',
  'add_task_link',
  'remove_task_link',
  'add_dependency',
  'remove_dependency',
  'move_task_to_list',
  'add_task_to_list',
  'remove_task_from_list',
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
  registerAttachmentTools(server, dependencies);
  registerCustomFieldTools(server, dependencies);
  registerCommentTools(server, dependencies);
  registerTagTools(server, dependencies);
  registerRelationshipTools(server, dependencies);
  registerMoveTools(server, dependencies);
  registerWorkspaceTools(server, dependencies);
  registerMemberTools(server, dependencies);
}
