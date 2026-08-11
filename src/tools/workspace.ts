import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { asArray, asRecord, stringId, stringValue } from '../utils/json.js';
import {
  IdSchema,
  NumericIdSchema,
  additiveAnnotations,
  mapConcurrent,
  mutatingAnnotations,
  readOnlyAnnotations,
  registerClickUpTool,
} from './shared.js';
import type { ToolDependencies } from './types.js';

const HierarchySchema = z
  .object({
    workspace_id: IdSchema.optional(),
    include_archived: z.boolean().optional().default(false),
    refresh: z.boolean().optional().default(false),
  })
  .strict();

const ListCreateFields = {
  name: z.string().trim().min(1).max(255),
  content: z.string().max(10_000).optional(),
  status: z.string().trim().min(1).optional(),
  priority: z.enum(['1', '2', '3', '4']).optional(),
  assignee: NumericIdSchema.optional(),
  due_date: z.string().datetime({ offset: true }).optional(),
} as const;

const CreateListInSpaceSchema = z
  .object({ space_id: IdSchema, ...ListCreateFields })
  .strict();
const CreateListInFolderSchema = z
  .object({ folder_id: IdSchema, ...ListCreateFields })
  .strict();
const GetListSchema = z.object({ list_id: IdSchema }).strict();
const UpdateListSchema = z
  .object({
    list_id: IdSchema,
    name: z.string().trim().min(1).max(255),
    content: z.string().max(10_000).optional(),
    status: z.string().trim().min(1).nullable().optional(),
    priority: z.enum(['1', '2', '3', '4']).nullable().optional(),
    assignee: NumericIdSchema.nullable().optional(),
    due_date: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const GetFolderSchema = z.object({ folder_id: IdSchema }).strict();
const CreateFolderSchema = z
  .object({ space_id: IdSchema, name: z.string().trim().min(1).max(255) })
  .strict();
const UpdateFolderSchema = z
  .object({ folder_id: IdSchema, name: z.string().trim().min(1).max(255) })
  .strict();

interface HierarchyList {
  id: string;
  name?: string;
  archived?: boolean;
  folder_id?: string;
  space_id?: string;
}

interface HierarchyFolder {
  id: string;
  name?: string;
  archived?: boolean;
  parent_folder_id?: string;
  lists: HierarchyList[];
  subfolders: HierarchyFolder[];
}

interface HierarchySpace {
  id: string;
  name?: string;
  private?: boolean;
  archived?: boolean;
  folders: HierarchyFolder[];
  folderless_lists: HierarchyList[];
}

export interface WorkspaceHierarchy {
  workspace_id: string;
  spaces: HierarchySpace[];
}

function normalizeList(value: unknown, spaceId?: string, folderId?: string): HierarchyList | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = stringId(record.id);
  if (id === undefined) return undefined;
  const name = stringValue(record.name);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(typeof record.archived === 'boolean' ? { archived: record.archived } : {}),
    ...(folderId === undefined ? {} : { folder_id: folderId }),
    ...(spaceId === undefined ? {} : { space_id: spaceId }),
  };
}

function normalizeFolder(value: unknown, spaceId: string): HierarchyFolder | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = stringId(record.id);
  if (id === undefined) return undefined;
  const name = stringValue(record.name);
  const parentFolder =
    record.parent_folder !== null &&
    typeof record.parent_folder === 'object' &&
    !Array.isArray(record.parent_folder)
      ? (record.parent_folder as Record<string, unknown>)
      : undefined;
  const parentFolderId =
    stringId(record.parent_folder_id) ??
    stringId(record.parent_id) ??
    stringId(parentFolder?.id);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(typeof record.archived === 'boolean' ? { archived: record.archived } : {}),
    ...(parentFolderId === undefined ? {} : { parent_folder_id: parentFolderId }),
    lists: asArray(record.lists).flatMap((list) => {
      const normalized = normalizeList(list, spaceId, id);
      return normalized === undefined ? [] : [normalized];
    }),
    subfolders: asArray(record.subfolders ?? record.folders).flatMap((folder) => {
      const normalized = normalizeFolder(folder, spaceId);
      return normalized === undefined ? [] : [normalized];
    }),
  };
}

function listBody(
  input: {
    name?: string | undefined;
    content?: string | undefined;
    status?: string | null | undefined;
    priority?: '1' | '2' | '3' | '4' | null | undefined;
    assignee?: string | null | undefined;
    due_date?: string | null | undefined;
  },
  operation: 'create' | 'update',
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.content !== undefined) body.content = input.content;
  if (input.status === null) body.unset_status = true;
  else if (input.status !== undefined) body.status = input.status;
  if (input.priority !== undefined) {
    body.priority = input.priority === null ? null : Number(input.priority);
  }
  if (input.assignee !== undefined) {
    body.assignee =
      input.assignee === null
        ? 'none'
        : operation === 'create'
          ? Number(input.assignee)
          : input.assignee;
  }
  if (input.due_date !== undefined) {
    body.due_date = input.due_date === null ? null : Date.parse(input.due_date);
    body.due_date_time = input.due_date !== null;
  }
  return body;
}

function invalidateHierarchy(dependencies: ToolDependencies): void {
  dependencies.cache.deletePrefix('clickup:hierarchy:');
}

export async function getWorkspaceHierarchyData(
  dependencies: ToolDependencies,
  workspaceId: string,
  includeArchived: boolean,
  refresh = false,
): Promise<WorkspaceHierarchy> {
  const cacheKey = `clickup:hierarchy:${workspaceId}:${String(includeArchived)}`;
  const cached = refresh ? undefined : dependencies.cache.get<WorkspaceHierarchy>(cacheKey);
  if (cached !== undefined) return cached;

  const spacesResponse = asRecord(
    await dependencies.client.request({
      path: `/team/${encodeURIComponent(workspaceId)}/space`,
      query: { archived: includeArchived },
    }),
    'spaces response',
  );

  const spaceCandidates = asArray(spacesResponse.spaces).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const id = stringId(record.id);
    if (id === undefined) return [];
    return [{ id, record }];
  });
  const spaces = await mapConcurrent(
    spaceCandidates,
    3,
    async ({ id, record }): Promise<HierarchySpace> => {
      // One request per worker at a time keeps total ClickUp concurrency at three.
      const foldersResponse = await dependencies.client.request({
        path: `/space/${encodeURIComponent(id)}/folder`,
        query: { archived: includeArchived },
      });
      const listsResponse = await dependencies.client.request({
        path: `/space/${encodeURIComponent(id)}/list`,
        query: { archived: includeArchived },
      });
      const foldersRecord = asRecord(foldersResponse, 'folders response');
      const listsRecord = asRecord(listsResponse, 'folderless lists response');
      const name = stringValue(record.name);
      return {
        id,
        ...(name === undefined ? {} : { name }),
        ...(typeof record.private === 'boolean' ? { private: record.private } : {}),
        ...(typeof record.archived === 'boolean' ? { archived: record.archived } : {}),
        folders: asArray(foldersRecord.folders).flatMap((folder) => {
          const normalized = normalizeFolder(folder, id);
          return normalized === undefined ? [] : [normalized];
        }),
        folderless_lists: asArray(listsRecord.lists).flatMap((list) => {
          const normalized = normalizeList(list, id);
          return normalized === undefined ? [] : [normalized];
        }),
      };
    },
  );

  const hierarchy = { workspace_id: workspaceId, spaces };
  dependencies.cache.set(cacheKey, hierarchy, 60_000);
  return hierarchy;
}

export function registerWorkspaceTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'get_workspace_hierarchy',
    title: 'Get Workspace Hierarchy',
    description: 'Get accessible Spaces, Folders, and Lists in a ClickUp Workspace.',
    inputSchema: HierarchySchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const data = await getWorkspaceHierarchyData(
        dependencies,
        workspaceId,
        input.include_archived,
        input.refresh,
      );
      return { data, summary: `Found ${data.spaces.length} Spaces in the Workspace hierarchy.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_list_in_space',
    title: 'Create List in Space',
    description: 'Create a folderless List in a ClickUp Space.',
    inputSchema: CreateListInSpaceSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const data = await dependencies.client.request({
        path: `/space/${encodeURIComponent(input.space_id)}/list`,
        method: 'POST',
        body: listBody(input, 'create'),
      });
      invalidateHierarchy(dependencies);
      return { data, summary: `Created List ${input.name}.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_list_in_folder',
    title: 'Create List in Folder',
    description: 'Create a List inside a ClickUp Folder.',
    inputSchema: CreateListInFolderSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const data = await dependencies.client.request({
        path: `/folder/${encodeURIComponent(input.folder_id)}/list`,
        method: 'POST',
        body: listBody(input, 'create'),
      });
      invalidateHierarchy(dependencies);
      return { data, summary: `Created List ${input.name}.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'get_list',
    title: 'Get List',
    description: 'Get the details and settings of one ClickUp List.',
    inputSchema: GetListSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => ({
      data: await dependencies.client.request({ path: `/list/${encodeURIComponent(input.list_id)}` }),
      summary: `Retrieved List ${input.list_id}.`,
    }),
  });

  registerClickUpTool(server, dependencies, {
    name: 'update_list',
    title: 'Update List',
    description: 'Update the supplied settings of a ClickUp List.',
    inputSchema: UpdateListSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const { list_id: listId, ...changes } = input;
      const body = listBody(changes, 'update');
      const data = await dependencies.client.request({
        path: `/list/${encodeURIComponent(listId)}`,
        method: 'PUT',
        body,
      });
      invalidateHierarchy(dependencies);
      return { data, summary: `Updated List ${listId}.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'get_folder',
    title: 'Get Folder',
    description: 'Get a ClickUp Folder and its Lists.',
    inputSchema: GetFolderSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => ({
      data: await dependencies.client.request({ path: `/folder/${encodeURIComponent(input.folder_id)}` }),
      summary: `Retrieved Folder ${input.folder_id}.`,
    }),
  });

  registerClickUpTool(server, dependencies, {
    name: 'create_folder',
    title: 'Create Folder',
    description: 'Create a Folder in a ClickUp Space.',
    inputSchema: CreateFolderSchema,
    annotations: additiveAnnotations,
    handler: async (input) => {
      const data = await dependencies.client.request({
        path: `/space/${encodeURIComponent(input.space_id)}/folder`,
        method: 'POST',
        body: { name: input.name },
      });
      invalidateHierarchy(dependencies);
      return { data, summary: `Created Folder ${input.name}.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'update_folder',
    title: 'Update Folder',
    description: 'Rename a ClickUp Folder.',
    inputSchema: UpdateFolderSchema,
    annotations: mutatingAnnotations,
    handler: async (input) => {
      const data = await dependencies.client.request({
        path: `/folder/${encodeURIComponent(input.folder_id)}`,
        method: 'PUT',
        body: { name: input.name },
      });
      invalidateHierarchy(dependencies);
      return { data, summary: `Updated Folder ${input.folder_id}.` };
    },
  });
}
