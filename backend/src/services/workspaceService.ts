import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { S3Service } from './s3Service';
import { UserContext } from '../types/user';
import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';

const WORKSPACE_DIR = resolveWorkspaceRoot();

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  lastModifiedBy?: string | null;
  visibility: 'private' | 'team';
  teamId?: string | null;
  currentPublishedVersionId?: string | null;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MembershipCheckOptions {
  requireEdit?: boolean;
  allowSystemAdmin?: boolean;
}

export type McpServerPolicy = {
  mcpServerAllowIds: string[];
  mcpServerDenyIds: string[];
  isAdmin: boolean;
  skipPlanApprovals: boolean;
};

export class WorkspaceService {
  private db: Knex;
  private s3Service: S3Service;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
    this.s3Service = new S3Service();
    this.ensureWorkspaceDir();
  }

  private async ensureWorkspaceDir(): Promise<void> {
    try {
      await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating workspace directory:', error);
    }
  }

  async listWorkspacesForUser(userId: string): Promise<Array<WorkspaceRecord & {
    role: WorkspaceRole;
    canEdit: boolean;
    canPublish: boolean;
    teamName?: string | null;
    publicationStatus: 'private_draft' | 'up_to_date' | 'changes_to_publish' | 'team_updates_available' | 'review_needed';
    linkedTeamWorkspaceId?: string | null;
    privateCopyWorkspaceId?: string | null;
    currentPublishedVersionNumber?: number | null;
    latestPublisherName?: string | null;
    lastPublishedAt?: string | null;
  }>> {
    const rows = await this.db('workspaces as w')
      .leftJoin('workspace_members as wm', function joinDirectMembership() {
        this.on('wm.workspaceId', '=', 'w.id').andOnVal('wm.userId', '=', userId);
      })
      .leftJoin('group_members as gm', function joinTeamMembership() {
        this.on('gm.groupId', '=', 'w.teamId').andOnVal('gm.userId', '=', userId);
      })
      .leftJoin('groups as g', 'g.id', 'w.teamId')
      .leftJoin('workspace_publication_links as private_link', 'private_link.privateWorkspaceId', 'w.id')
      .leftJoin('workspaces as linked_team', 'linked_team.id', 'private_link.teamWorkspaceId')
      .leftJoin('workspace_members as linked_team_member', function joinLinkedTeamMembership() {
        this.on('linked_team_member.workspaceId', '=', 'private_link.teamWorkspaceId')
          .andOnVal('linked_team_member.userId', '=', userId);
      })
      .leftJoin('group_members as linked_team_group_member', function joinLinkedTeamGroupMembership() {
        this.on('linked_team_group_member.groupId', '=', 'linked_team.teamId')
          .andOnVal('linked_team_group_member.userId', '=', userId);
      })
      .leftJoin('workspace_publication_links as team_link', function joinPrivateCopy() {
        this.on('team_link.teamWorkspaceId', '=', 'w.id').andOnVal('team_link.userId', '=', userId);
      })
      .leftJoin(
        'workspace_published_versions as published',
        'published.id',
        this.db.raw('COALESCE(w."currentPublishedVersionId", linked_team."currentPublishedVersionId")'),
      )
      .leftJoin('users as publisher', 'publisher.id', 'published.publisherUserId')
      .distinct(
        'w.id',
        'w.name',
        'w.slug',
        'w.ownerId',
        'w.lastModifiedBy',
        'w.visibility',
        'w.teamId',
        'w.currentPublishedVersionId',
        'w.contentRevision',
        'w.createdAt',
        'w.updatedAt',
        'wm.role as directRole',
        'wm.canEdit as directCanEdit',
        'g.name as teamName',
        'private_link.teamWorkspaceId as linkedTeamWorkspaceId',
        'linked_team.teamId as linkedTeamId',
        'linked_team.currentPublishedVersionId as linkedTeamCurrentPublishedVersionId',
        'private_link.basePublishedVersionId',
        'private_link.basePrivateContentRevision',
        'private_link.hasUnpublishedChanges',
        'linked_team_member.role as linkedTeamRole',
        'linked_team_group_member.userId as linkedTeamGroupMemberUserId',
        'team_link.privateWorkspaceId as privateCopyWorkspaceId',
        'published.versionNumber as currentPublishedVersionNumber',
        'published.createdAt as lastPublishedAt',
        'publisher.displayName as latestPublisherName',
      )
      .where((query) => {
        query
          .where((privateQuery) => {
            privateQuery.where('w.visibility', 'private').andWhere('w.ownerId', userId);
          })
          .orWhere((teamQuery) => {
            teamQuery
              .where('w.visibility', 'team')
              .andWhere((accessQuery) => {
                accessQuery
                  .where((groupBackedQuery) => {
                    groupBackedQuery.whereNotNull('w.teamId').whereNotNull('gm.userId');
                  })
                  .orWhere((legacyQuery) => {
                    legacyQuery.whereNull('w.teamId').whereNotNull('wm.userId');
                  });
              });
          });
      })
      .orderBy('w.updatedAt', 'desc');

    return rows.map((row: any) => {
      const visibility = row.visibility === 'team' ? 'team' : 'private';
      const privateChanged = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && (
          Boolean(row.hasUnpublishedChanges)
          || Number(row.contentRevision || 0) !== Number(row.basePrivateContentRevision || 0)
        );
      const linkedTeamAccessible = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && (
          row.linkedTeamId
            ? Boolean(row.linkedTeamGroupMemberUserId)
            : Boolean(row.linkedTeamRole)
        );
      const teamChanged = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && linkedTeamAccessible
        && String(row.linkedTeamCurrentPublishedVersionId || '') !== String(row.basePublishedVersionId || '');
      const publicationStatus = visibility === 'team'
        ? 'up_to_date'
        : !row.linkedTeamWorkspaceId
          ? 'private_draft'
          : privateChanged && teamChanged
            ? 'review_needed'
            : privateChanged
              ? 'changes_to_publish'
              : teamChanged
                ? 'team_updates_available'
                : 'up_to_date';

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        ownerId: row.ownerId,
        lastModifiedBy: row.lastModifiedBy,
        visibility,
        teamId: row.teamId,
        currentPublishedVersionId: row.currentPublishedVersionId,
        contentRevision: Number(row.contentRevision || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        role: visibility === 'private' ? 'owner' : (row.directRole || 'viewer') as WorkspaceRole,
        canEdit: visibility === 'private',
        canPublish: visibility === 'private'
          ? !row.linkedTeamWorkspaceId
            || (
              (row.linkedTeamRole === 'owner' || row.linkedTeamRole === 'editor')
              && linkedTeamAccessible
            )
          : row.directRole === 'owner' || row.directRole === 'editor',
        teamName: row.teamName || null,
        publicationStatus,
        linkedTeamWorkspaceId: row.linkedTeamWorkspaceId || null,
        privateCopyWorkspaceId: row.privateCopyWorkspaceId || null,
        currentPublishedVersionNumber: (
          visibility === 'private'
          && row.linkedTeamWorkspaceId
          && !linkedTeamAccessible
        ) || row.currentPublishedVersionNumber == null
          ? null
          : Number(row.currentPublishedVersionNumber),
        latestPublisherName: visibility === 'private' && row.linkedTeamWorkspaceId && !linkedTeamAccessible
          ? null
          : row.latestPublisherName || null,
        lastPublishedAt: visibility === 'private' && row.linkedTeamWorkspaceId && !linkedTeamAccessible
          ? null
          : row.lastPublishedAt || null,
      };
    });
  }

  async listEligibleTeams(userId: string): Promise<Array<{ id: string; name: string }>> {
    return this.db('groups as g')
      .join('group_members as gm', 'gm.groupId', 'g.id')
      .where('gm.userId', userId)
      .select(
        'g.id',
        'g.name',
      )
      .orderBy('g.name', 'asc');
  }

  async createWorkspace(user: UserContext, name?: string): Promise<WorkspaceRecord> {
    const workspaceId = uuidv4();
    const resolvedName = await this.resolveWorkspaceNameForCreate(user.userId, name);
    const slug = await this.generateUniqueSlug(resolvedName);
    const [workspace] = await this.db<WorkspaceRecord>('workspaces')
      .insert({
        id: workspaceId,
        name: resolvedName,
        slug,
        ownerId: user.userId,
        lastModifiedBy: user.userId,
        visibility: 'private',
        contentRevision: 0,
      })
      .returning('*');

    await this.db('workspace_members').insert({
      workspaceId,
      userId: user.userId,
      role: 'owner',
      canEdit: true,
    });

    await this.createWorkspaceDirectory(workspaceId);

    const { skipPlanApprovals: _omit, ...created } = workspace as WorkspaceRecord & { skipPlanApprovals?: boolean };
    return created as WorkspaceRecord;
  }

  async renameWorkspace(workspaceId: string, userId: string, name: string): Promise<WorkspaceRecord> {
    await this.ensureMembership(workspaceId, userId, { requireEdit: true });
    const normalizedName = this.normalizeWorkspaceName(name);
    if (!normalizedName) {
      throw new Error('Workspace name cannot be empty');
    }

    await this.db<WorkspaceRecord>('workspaces')
      .where({ id: workspaceId })
      .update({
        name: normalizedName,
        updatedAt: this.db.fn.now(),
        lastModifiedBy: userId,
      });

    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }
    const { skipPlanApprovals: _omit, ...renamed } = workspace as WorkspaceRecord & { skipPlanApprovals?: boolean };
    return renamed as WorkspaceRecord;
  }

  async getWorkspaceForUser(workspaceId: string, userId: string): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    return this.ensureMembership(workspaceId, userId);
  }

  async ensureMembership(
    workspaceId: string,
    userId: string,
    options: MembershipCheckOptions = {},
  ): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }
    const { skipPlanApprovals: _omitPlan, ...workspaceRest } = workspace as WorkspaceRecord & {
      skipPlanApprovals?: boolean;
    };
    const normalizedWorkspace: WorkspaceRecord = workspaceRest;

    const isSystemAdmin = Boolean(
      options.allowSystemAdmin
      && await this.db('users').where({ id: userId, isAdmin: true }).first(),
    );

    const directMembership = isSystemAdmin
      ? null
      : await this.db<WorkspaceMembershipRecord>('workspace_members')
        .where({ workspaceId, userId })
        .first();

    let membership = directMembership;
    if (isSystemAdmin) {
      membership = {
        workspaceId,
        userId,
        role: 'owner',
        canEdit: true,
        createdAt: normalizedWorkspace.createdAt,
        updatedAt: normalizedWorkspace.updatedAt,
      };
    } else if (normalizedWorkspace.visibility === 'private') {
      if (normalizedWorkspace.ownerId !== userId) {
        throw new AccessDeniedError('Private workspace access denied');
      }
      membership = membership || {
        workspaceId,
        userId,
        role: 'owner',
        canEdit: true,
        createdAt: normalizedWorkspace.createdAt,
        updatedAt: normalizedWorkspace.updatedAt,
      };
    } else if (normalizedWorkspace.teamId) {
      const groupMembership = await this.db('group_members')
        .where({ groupId: normalizedWorkspace.teamId, userId })
        .first();
      if (!groupMembership) {
        throw new AccessDeniedError('Team membership is required to access this workspace');
      }
      membership = membership || {
        workspaceId,
        userId,
        role: 'viewer',
        canEdit: false,
        createdAt: groupMembership.createdAt,
        updatedAt: groupMembership.updatedAt,
      };
    }

    if (!membership) {
      throw new AccessDeniedError('Workspace access denied');
    }

    const normalizedMembership: WorkspaceMembershipRecord = {
      ...membership,
      role: membership.role as WorkspaceRole,
      canEdit: isSystemAdmin || (normalizedWorkspace.visibility === 'private' && Boolean(membership.canEdit)),
    };

    if (options.requireEdit && normalizedWorkspace.visibility === 'team' && !isSystemAdmin) {
      throw new AccessDeniedError('Team workspaces are read-only. Work privately to make changes.');
    }
    if (options.requireEdit && !normalizedMembership.canEdit) {
      throw new AccessDeniedError('Workspace is read-only for this user');
    }

    return { workspace: normalizedWorkspace, membership: normalizedMembership };
  }

  async getMcpServerPolicy(
    workspaceId: string,
    userId: string,
    options: MembershipCheckOptions = {},
  ): Promise<McpServerPolicy> {
    const { membership } = await this.ensureMembership(workspaceId, userId, options);
    const workspacePolicy = await this.db('workspaces')
      .select('skipPlanApprovals')
      .where({ id: workspaceId })
      .first();
    const isAdmin = membership.role === 'owner';

    const allow: string[] = [];
    const deny: string[] = [];
    try {
      const rows = await this.db('mcp_server_grants')
        .select('serverId', 'effect')
        .where({ workspaceId, userId });
      for (const row of rows as any[]) {
        const serverId = typeof row?.serverId === 'string' ? row.serverId.trim() : '';
        const effect = typeof row?.effect === 'string' ? row.effect.trim().toLowerCase() : '';
        if (!serverId) continue;
        if (effect === 'deny') deny.push(serverId);
        else if (effect === 'allow') allow.push(serverId);
      }
    } catch (error) {
      // Best-effort: treat as no explicit grants.
      console.warn('Failed to load mcp_server_grants; continuing without explicit allow/deny', error);
    }

    return {
      mcpServerAllowIds: Array.from(new Set(allow)).sort(),
      mcpServerDenyIds: Array.from(new Set(deny)).sort(),
      isAdmin,
      skipPlanApprovals: Boolean(workspacePolicy?.skipPlanApprovals),
    };
  }

  async deleteWorkspace(workspaceId: string, userId: string): Promise<void> {
    const { workspace, membership } = await this.ensureMembership(workspaceId, userId);
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only workspace owners can delete a workspace');
    }

    await this.performWorkspaceDeletion(workspace.id);
  }

  async deleteWorkspaceForCleanup(workspaceId: string): Promise<boolean> {
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      return false;
    }
    await this.performWorkspaceDeletion(workspace.id);
    return true;
  }

  async addCollaborator(
    workspaceId: string,
    actingUserId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    const { membership } = await this.ensureMembership(workspaceId, actingUserId);
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (workspace?.visibility !== 'team') {
      throw new ConflictError('Private workspaces cannot have collaborators');
    }
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only Team owners can manage publishing access');
    }
    if (workspace.teamId) {
      const teamMember = await this.db('group_members')
        .where({ groupId: workspace.teamId, userId: targetUserId })
        .first();
      if (!teamMember) {
        throw new AccessDeniedError('Publishing access can only be granted to a member of this team');
      }
    }

    const canEdit = role !== 'viewer';
    const existing = await this.db('workspace_members').where({ workspaceId, userId: targetUserId }).first();
    if (existing) {
      await this.db('workspace_members')
        .where({ workspaceId, userId: targetUserId })
        .update({
          role,
          canEdit,
          updatedAt: this.db.fn.now(),
        });
      return;
    }

    await this.db('workspace_members').insert({
      workspaceId,
      userId: targetUserId,
      role,
      canEdit,
    });
  }

  async removeCollaborator(workspaceId: string, actingUserId: string, targetUserId: string): Promise<void> {
    const { membership } = await this.ensureMembership(workspaceId, actingUserId);
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only workspace owners can remove collaborators');
    }

    const target = await this.db<WorkspaceMembershipRecord>('workspace_members')
      .where({ workspaceId, userId: targetUserId })
      .first();
    if (!target) {
      throw new NotFoundError('Collaborator not found');
    }
    if (target.role === 'owner') {
      throw new AccessDeniedError('Cannot remove workspace owner');
    }

    await this.db('workspace_members').where({ workspaceId, userId: targetUserId }).del();
  }

  async listCollaborators(
    workspaceId: string,
    userId: string,
  ): Promise<Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>> {
    await this.ensureMembership(workspaceId, userId);
    const collaborators = await this.db('workspace_members')
      .join('users', 'workspace_members.userId', 'users.id')
      .select(
        'workspace_members.userId',
        'workspace_members.role',
        'workspace_members.canEdit',
        'users.displayName',
      )
      .where('workspace_members.workspaceId', workspaceId)
      .orderBy('users.displayName', 'asc');

    return collaborators.map((row: any) => ({
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as WorkspaceRole,
      canEdit: Boolean(row.canEdit),
    }));
  }

  async touchWorkspace(
    workspaceId: string,
    userId: string,
    options: { contentChanged?: boolean } = {},
  ): Promise<void> {
    await this.db('workspaces')
      .where({ id: workspaceId })
      .update({
        updatedAt: this.db.fn.now(),
        lastModifiedBy: userId,
        ...(options.contentChanged
          ? { contentRevision: this.db.raw('COALESCE("contentRevision", 0) + 1') }
          : {}),
      });
  }

  private async createWorkspaceDirectory(workspaceId: string): Promise<void> {
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    await fs.mkdir(workspacePath, { recursive: true });
  }

  async cleanupWorkspaceArtifacts(workspaceId: string): Promise<void> {
    await this.performWorkspaceCleanup(workspaceId);
  }

  private async performWorkspaceDeletion(workspaceId: string): Promise<void> {
    const publishedVersions = await this.db('workspace_published_versions')
      .select('id')
      .where({ teamWorkspaceId: workspaceId })
      .catch(() => [] as Array<{ id: string }>);
    await this.db('workspaces').where({ id: workspaceId }).del();
    await this.performWorkspaceCleanup(workspaceId);
    await Promise.all(
      publishedVersions.map((version) =>
        fs.rm(path.join(WORKSPACE_DIR, '.published-versions', String(version.id)), {
          recursive: true,
          force: true,
        }),
      ),
    );
  }

  private async performWorkspaceCleanup(workspaceId: string): Promise<void> {
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    await fs.rm(workspacePath, { recursive: true, force: true });
    try {
      await this.s3Service.deletePrefix(`${workspaceId}/`);
    } catch (error) {
      console.error(`Failed to delete S3 objects for workspace: ${workspaceId}`, error);
    }
  }

  private normalizeWorkspaceName(name?: string | null): string {
    return String(name ?? '').trim().slice(0, 255);
  }

  private async resolveWorkspaceNameForCreate(userId: string, name?: string): Promise<string> {
    const normalized = this.normalizeWorkspaceName(name);
    if (normalized) {
      return normalized;
    }
    return this.generateNextUntitledName(userId);
  }

  private async generateNextUntitledName(userId: string): Promise<string> {
    const rows = await this.db('workspace_members')
      .join('workspaces', 'workspace_members.workspaceId', 'workspaces.id')
      .select('workspaces.name')
      .where('workspace_members.userId', userId)
      .andWhere('workspaces.name', 'like', 'Untitled-%');

    let maxSuffix = 0;
    for (const row of rows as Array<{ name?: string }>) {
      const match = /^Untitled-(\d+)$/.exec(String(row?.name || '').trim());
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value)) {
        maxSuffix = Math.max(maxSuffix, value);
      }
    }
    return `Untitled-${maxSuffix + 1}`;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'workspace';
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let candidate = base;
    let counter = 1;
    while (true) {
      const existing = await this.db('workspaces').where({ slug: candidate }).first();
      if (!existing) {
        return candidate;
      }
      candidate = `${base}-${counter}`;
      counter += 1;
    }
  }
}
