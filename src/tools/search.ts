import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { QueryValue } from '../clickup/client.js';
import { ToolFailure } from '../errors.js';
import { asArray, asRecord, isRecord, stringId, stringValue } from '../utils/json.js';
import { includesNormalized, normalizeSearchText } from '../utils/text.js';
import {
  DateTimeSchema,
  NumericIdSchema,
  readOnlyAnnotations,
  registerClickUpTool,
  resolveTaskTypes,
} from './shared.js';
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
const FilterTasksSchema = z
  .object({
    ...SearchPagingFields,
    tags: z.array(z.string().trim().min(1).max(255)).min(1).max(100).optional(),
    statuses: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional(),
    assignees: z.array(NumericIdSchema).min(1).max(100).optional(),
    list_ids: z.array(NumericIdSchema).min(1).max(100).optional(),
    folder_ids: z.array(NumericIdSchema).min(1).max(100).optional(),
    space_ids: z.array(NumericIdSchema).min(1).max(100).optional(),
    due_date_from: DateTimeSchema.optional(),
    due_date_to: DateTimeSchema.optional(),
    completion_date_from: DateTimeSchema.optional(),
    completion_date_to: DateTimeSchema.optional(),
    task_types: z.array(z.string().trim().min(1).max(255)).min(1).max(100).optional(),
    subtasks: z.boolean().optional().default(true),
    order_by: z.enum(['id', 'created', 'updated', 'due_date']).optional(),
    reverse: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const ranges = [
      ['due_date_from', input.due_date_from, 'due_date_to', input.due_date_to],
      [
        'completion_date_from',
        input.completion_date_from,
        'completion_date_to',
        input.completion_date_to,
      ],
    ] as const;
    for (const [fromName, from, toName, to] of ranges) {
      if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
        context.addIssue({
          code: 'custom',
          path: [toName],
          message: `${toName} must be later than ${fromName}.`,
        });
      }
    }
  });

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
  status?: string;
  assignee_ids?: string[];
  due_date?: number;
  completion_date?: number;
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
  const status = isRecord(candidate.status)
    ? stringValue(candidate.status.status)
    : stringValue(candidate.status);
  const dueDate = timestampValue(candidate.due_date);
  const completionDate = timestampValue(candidate.date_done);
  return {
    type: 'task',
    id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(Object.keys(location).length === 0 ? {} : { location }),
    ...(url === undefined ? {} : { url }),
    ...(customItemId === undefined ? {} : { custom_item_id: customItemId }),
    ...(status === undefined ? {} : { status }),
    assignee_ids: asArray(candidate.assignees).flatMap((assignee) => {
      if (typeof assignee === 'string' || typeof assignee === 'number') {
        const id = stringId(assignee);
        return id === undefined ? [] : [id];
      }
      const id = isRecord(assignee) ? stringId(assignee.id) : undefined;
      return id === undefined ? [] : [id];
    }),
    ...(dueDate === undefined ? {} : { due_date: dueDate }),
    ...(completionDate === undefined ? {} : { completion_date: completionDate }),
    tags: asArray(candidate.tags).flatMap((tag) => {
      if (typeof tag === 'string') return [tag];
      return isRecord(tag) && typeof tag.name === 'string' ? [tag.name] : [];
    }),
  };
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  subtasks?: boolean;
  query?: Record<string, QueryValue>;
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
          subtasks: options.subtasks ?? true,
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

interface FilterPredicateOptions {
  tags?: readonly string[] | undefined;
  statuses?: readonly string[] | undefined;
  assignees?: readonly string[] | undefined;
  listIds?: readonly string[] | undefined;
  folderIds?: readonly string[] | undefined;
  spaceIds?: readonly string[] | undefined;
  taskTypeIds?: readonly string[] | undefined;
  dueDateFrom?: number | undefined;
  dueDateTo?: number | undefined;
  completionDateFrom?: number | undefined;
  completionDateTo?: number | undefined;
}

function normalizedSet(values: readonly string[] | undefined): Set<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(values.map((value) => normalizeSearchText(value)));
}

function idSet(values: readonly string[] | undefined): Set<string> | undefined {
  return values === undefined ? undefined : new Set(values);
}

function taskFilterPredicate(filters: FilterPredicateOptions): (task: SearchItem) => boolean {
  const tags = normalizedSet(filters.tags);
  const statuses = normalizedSet(filters.statuses);
  const assignees = idSet(filters.assignees);
  const listIds = idSet(filters.listIds);
  const folderIds = idSet(filters.folderIds);
  const spaceIds = idSet(filters.spaceIds);
  const taskTypeIds = idSet(filters.taskTypeIds);
  return (task) => {
    if (
      tags !== undefined &&
      !(task.tags?.some((tag) => tags.has(normalizeSearchText(tag))) ?? false)
    ) return false;
    if (
      statuses !== undefined &&
      (task.status === undefined || !statuses.has(normalizeSearchText(task.status)))
    ) return false;
    if (
      assignees !== undefined &&
      !(task.assignee_ids?.some((assignee) => assignees.has(assignee)) ?? false)
    ) return false;
    const scopes = [
      [listIds, task.location?.list_id],
      [folderIds, task.location?.folder_id],
      [spaceIds, task.location?.space_id],
    ] as const;
    if (
      scopes.some(
        ([allowed, actual]) =>
          allowed !== undefined && (actual === undefined || !allowed.has(actual)),
      )
    ) return false;
    if (
      taskTypeIds !== undefined &&
      (task.custom_item_id === undefined || !taskTypeIds.has(task.custom_item_id))
    ) return false;
    if (
      filters.dueDateFrom !== undefined &&
      (task.due_date ?? Number.NEGATIVE_INFINITY) <= filters.dueDateFrom
    ) return false;
    if (
      filters.dueDateTo !== undefined &&
      (task.due_date ?? Number.POSITIVE_INFINITY) >= filters.dueDateTo
    ) return false;
    if (
      filters.completionDateFrom !== undefined &&
      (task.completion_date ?? Number.NEGATIVE_INFINITY) <= filters.completionDateFrom
    ) return false;
    if (
      filters.completionDateTo !== undefined &&
      (task.completion_date ?? Number.POSITIVE_INFINITY) >= filters.completionDateTo
    ) return false;
    return true;
  };
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
    name: 'filter_tasks',
    title: 'Filter Tasks',
    description:
      'Retrieve Tasks using composable server-side filters. Arrays are OR within a filter and filters are ANDed. Work is bounded by limit and max_pages.',
    inputSchema: FilterTasksSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const workspaceId = dependencies.client.requireWorkspaceId(input.workspace_id);
      const taskTypes = input.task_types === undefined
        ? undefined
        : await resolveTaskTypes(dependencies, workspaceId, input.task_types);
      const dueDateFrom = input.due_date_from === undefined ? undefined : Date.parse(input.due_date_from);
      const dueDateTo = input.due_date_to === undefined ? undefined : Date.parse(input.due_date_to);
      const completionDateFrom = input.completion_date_from === undefined
        ? undefined
        : Date.parse(input.completion_date_from);
      const completionDateTo = input.completion_date_to === undefined
        ? undefined
        : Date.parse(input.completion_date_to);
      const query = {
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
        ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        ...(input.list_ids === undefined ? {} : { list_ids: input.list_ids }),
        ...(input.folder_ids === undefined ? {} : { project_ids: input.folder_ids }),
        ...(input.space_ids === undefined ? {} : { space_ids: input.space_ids }),
        ...(dueDateFrom === undefined ? {} : { due_date_gt: dueDateFrom }),
        ...(dueDateTo === undefined ? {} : { due_date_lt: dueDateTo }),
        ...(completionDateFrom === undefined ? {} : { date_done_gt: completionDateFrom }),
        ...(completionDateTo === undefined ? {} : { date_done_lt: completionDateTo }),
        ...(taskTypes === undefined ? {} : { custom_items: taskTypes.map(({ id }) => id) }),
        ...(input.order_by === undefined ? {} : { order_by: input.order_by }),
        ...(input.reverse === undefined ? {} : { reverse: input.reverse }),
      };
      const result = await sweepTasks(dependencies, {
        workspaceId,
        includeClosed: input.include_closed,
        cursor: decodeCursor(input.cursor, 'tasks', ['tasks']),
        limit: input.limit,
        maxPages: Math.min(input.max_pages ?? dependencies.config.searchMaxPages, dependencies.config.searchMaxPages),
        subtasks: input.subtasks,
        query,
        predicate: taskFilterPredicate({
          tags: input.tags,
          statuses: input.statuses,
          assignees: input.assignees,
          listIds: input.list_ids,
          folderIds: input.folder_ids,
          spaceIds: input.space_ids,
          taskTypeIds: taskTypes?.map(({ id }) => id),
          dueDateFrom,
          dueDateTo,
          completionDateFrom,
          completionDateTo,
        }),
      });
      return {
        data: {
          ...(taskTypes === undefined ? {} : { task_types: taskTypes }),
          ...result,
        },
        summary: `Found ${result.items.length} Tasks matching the composed filters${result.truncated ? '; results are partial' : ''}.`,
      };
    },
  });

}
