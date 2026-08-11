import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { asArray, asRecord, isRecord, stringId, stringValue } from '../utils/json.js';
import { includesNormalized, normalizeSearchText } from '../utils/text.js';
import { readOnlyAnnotations, registerClickUpTool } from './shared.js';
import type { ToolDependencies } from './types.js';
import { getWorkspaceHierarchyData } from './workspace.js';

const IdSchema = z.string().trim().min(1);
const SearchPagingFields = {
  workspace_id: IdSchema.optional(),
  include_closed: z.boolean().optional().default(false),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  max_pages: z.number().int().min(1).max(20).optional(),
} as const;

const SearchWorkspaceSchema = z
  .object({
    ...SearchPagingFields,
    query: z.string().trim().min(1).max(500),
    entity_types: z
      .array(z.enum(['task', 'space', 'folder', 'list']))
      .min(1)
      .max(4)
      .optional()
      .default(['task', 'space', 'folder', 'list']),
  })
  .strict();
const SearchByTypeSchema = z
  .object({ ...SearchPagingFields, task_type: z.string().trim().min(1).max(255) })
  .strict();
const SearchByTagSchema = z
  .object({ ...SearchPagingFields, tag: z.string().trim().min(1).max(255) })
  .strict();

interface CursorPayload {
  version: 1;
  stage: 'hierarchy' | 'tasks';
  page: number;
  offset: number;
}

interface SearchItem {
  type: 'task' | 'space' | 'folder' | 'list';
  id: string;
  name?: string;
  description?: string;
  location?: Record<string, string>;
  url?: string;
  custom_item_id?: string;
  tags?: string[];
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(
  value: string | undefined,
  defaultStage: CursorPayload['stage'],
  allowedStages: readonly CursorPayload['stage'][] = ['hierarchy', 'tasks'],
): CursorPayload {
  if (value === undefined) return { version: 1, stage: defaultStage, page: 0, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      (parsed.stage !== 'hierarchy' && parsed.stage !== 'tasks') ||
      !allowedStages.includes(parsed.stage) ||
      !Number.isSafeInteger(parsed.page) ||
      (parsed.page as number) < 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as unknown as CursorPayload;
  } catch {
    throw new ToolFailure('CURSOR_INVALID', 'The search cursor is invalid or malformed.', false);
  }
}

function taskItem(candidate: unknown): SearchItem | undefined {
  if (!isRecord(candidate)) return undefined;
  const id = stringId(candidate.id);
  if (id === undefined) return undefined;
  const list = isRecord(candidate.list) ? candidate.list : undefined;
  const folder = isRecord(candidate.folder) ? candidate.folder : undefined;
  const space = isRecord(candidate.space) ? candidate.space : undefined;
  const location: Record<string, string> = {};
  const listId = stringId(list?.id);
  const folderId = stringId(folder?.id);
  const spaceId = stringId(space?.id);
  if (listId !== undefined) location.list_id = listId;
  if (folderId !== undefined) location.folder_id = folderId;
  if (spaceId !== undefined) location.space_id = spaceId;
  const name = stringValue(candidate.name);
  const description = stringValue(candidate.description);
  const url = stringValue(candidate.url);
  const customItemId = candidate.custom_item_id === null ? '0' : stringId(candidate.custom_item_id);
  return {
    type: 'task',
    id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(Object.keys(location).length === 0 ? {} : { location }),
    ...(url === undefined ? {} : { url }),
    ...(customItemId === undefined ? {} : { custom_item_id: customItemId }),
    tags: asArray(candidate.tags).flatMap((tag) => {
      if (typeof tag === 'string') return [tag];
      return isRecord(tag) && typeof tag.name === 'string' ? [tag.name] : [];
    }),
  };
}

function taskMatchesQuery(task: SearchItem, normalizedQuery: string): boolean {
  return includesNormalized(task.name, normalizedQuery) || includesNormalized(task.description, normalizedQuery);
}

function hierarchyItems(
  hierarchy: Awaited<ReturnType<typeof getWorkspaceHierarchyData>>,
  selectedTypes: Set<SearchItem['type']>,
): SearchItem[] {
  const items: SearchItem[] = [];
  const appendFolder = (folder: (typeof hierarchy.spaces)[number]['folders'][number], spaceId: string): void => {
    if (selectedTypes.has('folder')) {
      items.push({
        type: 'folder',
        id: folder.id,
        ...(folder.name === undefined ? {} : { name: folder.name }),
        location: {
          space_id: spaceId,
          ...(folder.parent_folder_id === undefined
            ? {}
            : { parent_folder_id: folder.parent_folder_id }),
        },
      });
    }
    if (selectedTypes.has('list')) {
      for (const list of folder.lists) {
        items.push({
          type: 'list',
          id: list.id,
          ...(list.name === undefined ? {} : { name: list.name }),
          location: { space_id: spaceId, folder_id: folder.id },
        });
      }
    }
    for (const subfolder of folder.subfolders) appendFolder(subfolder, spaceId);
  };
  for (const space of hierarchy.spaces) {
    if (selectedTypes.has('space')) items.push({ type: 'space', id: space.id, ...(space.name === undefined ? {} : { name: space.name }) });
    for (const folder of space.folders) appendFolder(folder, space.id);
    if (selectedTypes.has('list')) {
      for (const list of space.folderless_lists) {
        items.push({
          type: 'list',
          id: list.id,
          ...(list.name === undefined ? {} : { name: list.name }),
          location: { space_id: space.id },
        });
      }
    }
  }
  return items;
}

/**
 * `last_page` is authoritative whenever ClickUp sends it; the page-size heuristic is only
 * a fallback for responses that omit the flag, and must never override an explicit false.
 */
function isLastPage(response: Record<string, unknown>, tasks: readonly unknown[]): boolean {
  if (typeof response.last_page === 'boolean') return response.last_page;
  return tasks.length < 100;
}

interface TaskSweepOptions {
  workspaceId: string;
  includeClosed: boolean;
  cursor: CursorPayload;
  limit: number;
  maxPages: number;
  query?: Record<string, string | readonly string[]>;
  predicate(task: SearchItem): boolean;
}

async function sweepTasks(
  dependencies: ToolDependencies,
  options: TaskSweepOptions,
): Promise<{
  items: SearchItem[];
  scanned_count: number;
  has_more: boolean;
  next_cursor?: string;
  truncated: boolean;
}> {
  const items: SearchItem[] = [];
  let scannedCount = 0;
  let page = options.cursor.page;
  let offset = options.cursor.offset;
  let pagesRead = 0;

  while (pagesRead < options.maxPages) {
    const response = asRecord(
      await dependencies.client.request({
        path: `/team/${encodeURIComponent(options.workspaceId)}/task`,
        query: {
          page,
          include_closed: options.includeClosed,
          subtasks: true,
          ...options.query,
        },
      }),
      'filtered tasks response',
    );
    pagesRead += 1;
    const tasks = asArray(response.tasks);
    for (let index = offset; index < tasks.length; index += 1) {
      const task = taskItem(tasks[index]);
      scannedCount += 1;
      if (task !== undefined && options.predicate(task)) items.push(task);
      if (items.length >= options.limit) {
        const nextOffset = index + 1;
        const lastPage = isLastPage(response, tasks);
        const hasMore = nextOffset < tasks.length || !lastPage;
        const next =
          nextOffset < tasks.length
            ? { version: 1 as const, stage: 'tasks' as const, page, offset: nextOffset }
            : { version: 1 as const, stage: 'tasks' as const, page: page + 1, offset: 0 };
        return {
          items,
          scanned_count: scannedCount,
          has_more: hasMore,
          ...(hasMore ? { next_cursor: encodeCursor(next) } : {}),
          truncated: hasMore,
        };
      }
    }

    const lastPage = isLastPage(response, tasks);
    if (lastPage) {
      return { items, scanned_count: scannedCount, has_more: false, truncated: false };
    }
    page += 1;
    offset = 0;
  }

  return {
    items,
    scanned_count: scannedCount,
    has_more: true,
    next_cursor: encodeCursor({ version: 1, stage: 'tasks', page, offset: 0 }),
    truncated: true,
  };
}

async function resolveTaskType(
  dependencies: ToolDependencies,
  workspaceId: string,
  requestedType: string,
): Promise<{ id: string; name?: string }> {
  const response = asRecord(
    await dependencies.client.request({
      path: `/team/${encodeURIComponent(workspaceId)}/custom_item`,
    }),
    'custom task types response',
  );
  const customCandidates = asArray(response.custom_items ?? response.custom_item_types).flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = stringId(value.id);
    if (id === undefined) return [];
    const name = stringValue(value.name);
    return [{ id, ...(name === undefined ? {} : { name }) }];
  });
  const candidates = [
    { id: '0', name: 'Task' },
    { id: '1', name: 'Milestone' },
    ...customCandidates.filter(({ id }) => id !== '0' && id !== '1'),
  ];
  const normalized = normalizeSearchText(requestedType);
  const matches = candidates.filter(
    (candidate) =>
      normalizeSearchText(candidate.id) === normalized ||
      (candidate.name !== undefined && normalizeSearchText(candidate.name) === normalized),
  );
  if (matches.length === 0) {
    throw new ToolFailure('TASK_TYPE_NOT_FOUND', `No task type matched ${requestedType}.`, false, {
      candidates,
    });
  }
  if (matches.length > 1 || matches[0] === undefined) {
    throw new ToolFailure('TASK_TYPE_AMBIGUOUS', `More than one task type matched ${requestedType}.`, false, {
      candidates: matches,
    });
  }
  return matches[0];
}

export function registerSearchTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'search_workspace',
    title: 'Search Workspace',
    description: 'Sweep accessible Tasks, Spaces, Folders, and Lists for normalized text matches.',
    inputSchema: SearchWorkspaceSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const selectedTypes = new Set(input.entity_types);
      const normalizedQuery = normalizeSearchText(input.query);
      const maxPages = Math.min(input.max_pages ?? dependencies.config.searchMaxPages, dependencies.config.searchMaxPages);
      let cursor = decodeCursor(input.cursor, 'hierarchy');
      let scannedCount = 0;
      const items: SearchItem[] = [];

      if (cursor.stage === 'hierarchy') {
        const hierarchyTypesSelected =
          selectedTypes.has('space') || selectedTypes.has('folder') || selectedTypes.has('list');
        const candidates = hierarchyTypesSelected
          ? hierarchyItems(
              await getWorkspaceHierarchyData(dependencies, workspaceId, false),
              selectedTypes,
            )
          : [];
        for (let index = cursor.offset; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          if (candidate === undefined) continue;
          scannedCount += 1;
          if (includesNormalized(candidate.name, normalizedQuery)) items.push(candidate);
          if (items.length >= input.limit) {
            const nextOffset = index + 1;
            const hasMore = nextOffset < candidates.length || selectedTypes.has('task');
            return {
              data: {
                items,
                scanned_count: scannedCount,
                has_more: hasMore,
                ...(hasMore
                  ? {
                      next_cursor: encodeCursor(
                        nextOffset < candidates.length
                          ? { version: 1, stage: 'hierarchy', page: 0, offset: nextOffset }
                          : { version: 1, stage: 'tasks', page: 0, offset: 0 },
                      ),
                    }
                  : {}),
                truncated: hasMore,
              },
              summary: `Found ${items.length} matching Workspace items${hasMore ? '; more results are available' : ''}.`,
            };
          }
        }
        cursor = { version: 1, stage: 'tasks', page: 0, offset: 0 };
      }

      if (!selectedTypes.has('task')) {
        return {
          data: { items, scanned_count: scannedCount, has_more: false, truncated: false },
          summary: `Found ${items.length} matching Workspace items.`,
        };
      }

      const remaining = input.limit - items.length;
      const taskResult = await sweepTasks(dependencies, {
        workspaceId,
        includeClosed: input.include_closed,
        cursor,
        limit: remaining,
        maxPages,
        predicate: (task) => taskMatchesQuery(task, normalizedQuery),
      });
      items.push(...taskResult.items);
      const data = {
        items,
        scanned_count: scannedCount + taskResult.scanned_count,
        has_more: taskResult.has_more,
        ...(taskResult.next_cursor === undefined ? {} : { next_cursor: taskResult.next_cursor }),
        truncated: taskResult.truncated,
      };
      return {
        data,
        summary: `Found ${items.length} matching Workspace items${data.truncated ? '; results are partial' : ''}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'search_tasks_by_task_type',
    title: 'Search Tasks by Task Type',
    description: 'Retrieve accessible ClickUp Tasks matching one custom task type.',
    inputSchema: SearchByTypeSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const taskType = await resolveTaskType(dependencies, workspaceId, input.task_type);
      const result = await sweepTasks(dependencies, {
        workspaceId,
        includeClosed: input.include_closed,
        cursor: decodeCursor(input.cursor, 'tasks', ['tasks']),
        limit: input.limit,
        maxPages: Math.min(input.max_pages ?? dependencies.config.searchMaxPages, dependencies.config.searchMaxPages),
        query: { custom_items: [taskType.id] },
        predicate: (task) => task.custom_item_id === taskType.id,
      });
      return {
        data: { task_type: taskType, ...result },
        summary: `Found ${result.items.length} Tasks with task type ${taskType.name ?? taskType.id}.`,
      };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'search_tasks_by_tag',
    title: 'Search Tasks by Tag',
    description: 'Retrieve accessible ClickUp Tasks with an exact tag.',
    inputSchema: SearchByTagSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const normalizedTag = normalizeSearchText(input.tag);
      const result = await sweepTasks(dependencies, {
        workspaceId,
        includeClosed: input.include_closed,
        cursor: decodeCursor(input.cursor, 'tasks', ['tasks']),
        limit: input.limit,
        maxPages: Math.min(input.max_pages ?? dependencies.config.searchMaxPages, dependencies.config.searchMaxPages),
        query: { tags: [input.tag] },
        predicate: (task) => task.tags?.some((tag) => normalizeSearchText(tag) === normalizedTag) ?? false,
      });
      return {
        data: { tag: input.tag, ...result },
        summary: `Found ${result.items.length} Tasks tagged ${input.tag}.`,
      };
    },
  });
}
