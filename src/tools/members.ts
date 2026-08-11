import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ToolFailure } from '../errors.js';
import { isRecord, stringId, stringValue } from '../utils/json.js';
import { normalizeSearchText } from '../utils/text.js';
import { readOnlyAnnotations, registerClickUpTool } from './shared.js';
import type { ToolDependencies } from './types.js';

const IdSchema = z.string().trim().min(1);
const WorkspaceInput = { workspace_id: IdSchema.optional() } as const;
const GetMembersSchema = z.object(WorkspaceInput).strict();
const FindMemberSchema = z
  .object({ ...WorkspaceInput, query: z.string().trim().min(1).max(320) })
  .strict();
const ResolveAssigneesSchema = z
  .object({
    ...WorkspaceInput,
    assignees: z.array(z.string().trim().min(1).max(320)).min(1).max(100),
  })
  .strict();

export interface WorkspaceMember {
  id: string;
  name?: string;
  email?: string;
  role?: number;
  custom_role?: string;
  profile_picture?: string;
  is_guest: boolean;
}

function normalizeMember(candidate: unknown): WorkspaceMember | undefined {
  if (!isRecord(candidate)) return undefined;
  const user = isRecord(candidate.user) ? candidate.user : candidate;
  const id = stringId(user.id);
  if (id === undefined) return undefined;
  const name = stringValue(user.username) ?? stringValue(user.name);
  const email = stringValue(user.email);
  const profilePicture = stringValue(user.profilePicture) ?? stringValue(user.profile_picture);
  const customRoleValue = user.custom_role;
  const customRole =
    typeof customRoleValue === 'string'
      ? customRoleValue
      : isRecord(customRoleValue)
        ? stringValue(customRoleValue.name)
        : undefined;
  const role = typeof user.role === 'number' && Number.isFinite(user.role) ? user.role : undefined;
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(role === undefined ? {} : { role }),
    ...(customRole === undefined ? {} : { custom_role: customRole }),
    ...(profilePicture === undefined ? {} : { profile_picture: profilePicture }),
    is_guest: role === 4 || role === 5,
  };
}

async function getMembers(
  dependencies: ToolDependencies,
  explicitWorkspaceId?: string,
): Promise<{ workspace_id: string; members: WorkspaceMember[] }> {
  const workspaceId = dependencies.client.requireWorkspaceId(explicitWorkspaceId);
  const cacheKey = `clickup:members:${workspaceId}`;
  const cached = dependencies.cache.get<WorkspaceMember[]>(cacheKey);
  if (cached !== undefined) return { workspace_id: workspaceId, members: cached };

  const workspaces = await dependencies.client.getAuthorizedWorkspaces();
  const workspace = workspaces.find(({ id }) => id === workspaceId);
  if (workspace === undefined) {
    throw new ToolFailure(
      'WORKSPACE_NOT_AUTHORIZED',
      `Workspace ${workspaceId} is not authorized for this token.`,
      false,
    );
  }
  const members = workspace.members.flatMap((candidate) => {
    const member = normalizeMember(candidate);
    return member === undefined ? [] : [member];
  });
  dependencies.cache.set(cacheKey, members, 60_000);
  return { workspace_id: workspaceId, members };
}

function memberMatches(member: WorkspaceMember, normalizedQuery: string): boolean {
  return (
    normalizeSearchText(member.id) === normalizedQuery ||
    (member.email !== undefined && normalizeSearchText(member.email).includes(normalizedQuery)) ||
    (member.name !== undefined && normalizeSearchText(member.name).includes(normalizedQuery))
  );
}

function exactMembers(members: WorkspaceMember[], normalizedQuery: string): WorkspaceMember[] {
  return members.filter(
    (member) =>
      normalizeSearchText(member.id) === normalizedQuery ||
      (member.email !== undefined && normalizeSearchText(member.email) === normalizedQuery) ||
      (member.name !== undefined && normalizeSearchText(member.name) === normalizedQuery),
  );
}

function resolveOne(
  query: string,
  members: WorkspaceMember[],
):
  | { status: 'resolved'; query: string; member: WorkspaceMember }
  | { status: 'ambiguous'; query: string; candidates: WorkspaceMember[] }
  | { status: 'not_found'; query: string } {
  const normalizedQuery = normalizeSearchText(query);
  const exact = exactMembers(members, normalizedQuery);
  if (exact.length === 1 && exact[0] !== undefined) {
    return { status: 'resolved', query, member: exact[0] };
  }
  if (exact.length > 1) return { status: 'ambiguous', query, candidates: exact };

  const matches = members.filter((member) => memberMatches(member, normalizedQuery));
  if (matches.length === 1 && matches[0] !== undefined) {
    return { status: 'resolved', query, member: matches[0] };
  }
  if (matches.length > 1) return { status: 'ambiguous', query, candidates: matches };
  return { status: 'not_found', query };
}

export function registerMemberTools(server: McpServer, dependencies: ToolDependencies): void {
  registerClickUpTool(server, dependencies, {
    name: 'get_workspace_members',
    title: 'Get Workspace Members',
    description: 'List members and guests available in a ClickUp Workspace.',
    inputSchema: GetMembersSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const data = await getMembers(dependencies, input.workspace_id);
      return { data, summary: `Found ${data.members.length} Workspace members and guests.` };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'find_member_by_name',
    title: 'Find Member by Name',
    description: 'Find ClickUp Workspace members by ID, name, or email without guessing ambiguity.',
    inputSchema: FindMemberSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const { workspace_id: workspaceId, members } = await getMembers(
        dependencies,
        input.workspace_id,
      );
      const resolution = resolveOne(input.query, members);
      const data = { workspace_id: workspaceId, ...resolution };
      const summary =
        resolution.status === 'resolved'
          ? `Resolved ${input.query} to member ${resolution.member.id}.`
          : resolution.status === 'ambiguous'
            ? `Found ${resolution.candidates.length} possible members for ${input.query}.`
            : `No Workspace member matched ${input.query}.`;
      return { data, summary };
    },
  });

  registerClickUpTool(server, dependencies, {
    name: 'resolve_assignees',
    title: 'Resolve Assignees',
    description: 'Resolve several proposed assignees to member IDs and expose ambiguous matches.',
    inputSchema: ResolveAssigneesSchema,
    annotations: readOnlyAnnotations,
    handler: async (input) => {
      const { workspace_id: workspaceId, members } = await getMembers(
        dependencies,
        input.workspace_id,
      );
      const resolutions = input.assignees.map((query) => resolveOne(query, members));
      const resolved = resolutions.flatMap((result) =>
        result.status === 'resolved' ? [{ query: result.query, member: result.member }] : [],
      );
      const ambiguous = resolutions.flatMap((result) =>
        result.status === 'ambiguous'
          ? [{ query: result.query, candidates: result.candidates }]
          : [],
      );
      const notFound = resolutions.flatMap((result) =>
        result.status === 'not_found' ? [result.query] : [],
      );
      return {
        data: {
          workspace_id: workspaceId,
          resolved,
          ambiguous,
          not_found: notFound,
          all_resolved: ambiguous.length === 0 && notFound.length === 0,
        },
        summary: `Resolved ${resolved.length} of ${input.assignees.length} assignees.`,
      };
    },
  });
}
