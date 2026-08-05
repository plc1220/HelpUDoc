import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { S3Service } from './s3Service';
import { UserContext } from '../types/user';
import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import { legacyWorkspaceRoleToNamedGrant } from './workspaceAudiencePolicy';

const WORKSPACE_DIR = resolveWorkspaceRoot();

export function buildWorkspaceTeamAccessQuery(db: Knex, workspaceId: string, teamId: string) {
  return db('groups as group')
    .leftJoin('workspace_team_grants as workspaceTeamGrant', function joinTeamGrant() {
      this.on('workspaceTeamGrant.teamId', '=', 'group.id')
        .andOnVal('workspaceTeamGrant.workspaceId', '=', workspaceId);
    })
    .where('group.id', teamId)
    .select(
      'group.id',
      'group.name',
      db.raw(`COALESCE("workspaceTeamGrant"."role", 'viewer') as role`),
    );
}

export type WorkspaceRole = 'owner' | 'editor' | 'contributor' | 'commenter' | 'viewer';

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  lastModifiedBy?: string | null;
  visibility: 'private' | 'team';
  workspaceType?: 'private' | 'team';
  editingPolicy?: 'direct' | 'review' | null;
  status?: 'active' | 'archived';
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
  /**
   * Allows platform support operations for shared workspaces only. Private
   * workspaces are intentionally excluded: their owner is the sole principal
   * the application may authorize.
   */
  allowSystemAdmin?: boolean;
}

export type McpServerPolicy = {
  mcpServerAllowIds: string[];
  mcpServerDenyIds: string[];
  isAdmin: boolean;
  skipPlanApprovals: boolean;
  workspaceMode: 'private' | 'shared_live' | 'published_read_only';
  workspaceRole: WorkspaceRole;
  canWriteWorkspace: boolean;
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
    audienceType: 'private' | 'selected_people' | 'team';
    publicationStatus: 'private_draft' | 'up_to_date' | 'changes_to_publish' | 'withdrawn' | 'team_updates_available' | 'review_needed';
    linkedTeamWorkspaceId?: string | null;
    privateCopyWorkspaceId?: string | null;
    currentPublishedVersionNumber?: number | null;
    publishedVersionCount?: number;
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
        'w.workspaceType',
        'w.editingPolicy',
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
        'published.sourceContentRevision as publishedContentRevision',
        'published.createdAt as lastPublishedAt',
        'publisher.displayName as latestPublisherName',
        this.db.raw(`(
          SELECT COUNT(*)::int
          FROM workspace_published_versions AS version_history
          WHERE version_history."teamWorkspaceId" = w.id
        ) as "publishedVersionCount"`),
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
                  .whereNotNull('wm.userId')
                  .orWhere((groupBackedQuery) => {
                    groupBackedQuery.whereNotNull('w.teamId').whereNotNull('gm.userId');
                  });
              });
          });
      })
      .andWhere('w.isSystem', false)
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
        && (Boolean(row.linkedTeamRole) || Boolean(row.linkedTeamGroupMemberUserId));
      const teamChanged = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && linkedTeamAccessible
        && String(row.linkedTeamCurrentPublishedVersionId || '') !== String(row.basePublishedVersionId || '');
      const needsInitialPublication = visibility === 'private'
        && Boolean(row.linkedTeamWorkspaceId)
        && !row.linkedTeamCurrentPublishedVersionId;
      const publicationStatus = visibility === 'team'
        ? row.currentPublishedVersionNumber == null
          ? Number(row.publishedVersionCount || 0) > 0
            ? 'withdrawn'
            : 'changes_to_publish'
          : Number(row.contentRevision || 0) !== Number(row.publishedContentRevision || 0)
            ? 'changes_to_publish'
            : 'up_to_date'
        : !row.linkedTeamWorkspaceId
          ? 'private_draft'
          : needsInitialPublication
            ? 'changes_to_publish'
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
        workspaceType: visibility === 'team' ? 'team' : 'private',
        editingPolicy: visibility === 'team' ? (row.editingPolicy || 'review') : null,
        teamId: row.teamId,
        currentPublishedVersionId: row.currentPublishedVersionId,
        contentRevision: Number(row.contentRevision || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        role: visibility === 'private' ? 'owner' : (row.directRole || 'viewer') as WorkspaceRole,
        canEdit: visibility === 'private'
          || row.directRole === 'owner'
          || (
            (row.editingPolicy || 'review') === 'direct'
            && (row.directRole === 'editor' || row.directRole === 'contributor')
          ),
        canPublish: visibility === 'team'
          && (row.directRole === 'owner' || row.directRole === 'editor'),
        teamName: row.teamName || null,
        audienceType: visibility === 'private' ? 'private' : row.teamId ? 'team' : 'selected_people',
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
        publishedVersionCount: visibility === 'team'
          ? Number(row.publishedVersionCount || 0)
          : 0,
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
        workspaceType: 'private',
        editingPolicy: null,
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
    const { workspace: currentWorkspace, membership } = await this.ensureMembership(
      workspaceId,
      userId,
      { requireEdit: true },
    );
    if (currentWorkspace.visibility === 'team' && membership.role !== 'owner') {
      throw new AccessDeniedError('Only the owner can rename a Shared workspace');
    }
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

    // Resolve private workspaces before any administrator override. A private
    // workspace is an owner-only boundary, not merely a UI visibility flag.
    if (normalizedWorkspace.visibility === 'private') {
      if (normalizedWorkspace.ownerId !== userId) {
        throw new AccessDeniedError('Private workspace access denied');
      }
      return {
        workspace: normalizedWorkspace,
        membership: {
          workspaceId,
          userId,
          role: 'owner',
          canEdit: true,
          createdAt: normalizedWorkspace.createdAt,
          updatedAt: normalizedWorkspace.updatedAt,
        },
      };
    }

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
    } else if (normalizedWorkspace.teamId && !membership) {
      const groupMembership = await this.db('group_members')
        .where({ groupId: normalizedWorkspace.teamId, userId })
        .first();
      if (!groupMembership) {
        throw new AccessDeniedError('Team membership is required to access this workspace');
      }
      membership = {
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

    const editingPolicy = normalizedWorkspace.editingPolicy || 'review';
    const roleCanEditShared = membership.role === 'owner'
      || (
        editingPolicy === 'direct'
        && (membership.role === 'editor' || membership.role === 'contributor')
      );
    const normalizedMembership: WorkspaceMembershipRecord = {
      ...membership,
      role: membership.role as WorkspaceRole,
      canEdit: isSystemAdmin || roleCanEditShared,
    };

    if (options.requireEdit && !normalizedMembership.canEdit) {
      if (normalizedWorkspace.visibility === 'team' && editingPolicy === 'review') {
        throw new AccessDeniedError('This Shared workspace uses Review mode. Submit changes for review.');
      }
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
      .select('skipPlanApprovals', 'visibility', 'editingPolicy')
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
      workspaceMode: workspacePolicy?.visibility === 'team' ? 'shared_live' : 'private',
      workspaceRole: membership.role,
      canWriteWorkspace: membership.canEdit,
    };
  }

  async deleteWorkspace(workspaceId: string, userId: string): Promise<void> {
    const { workspace, membership } = await this.ensureMembership(workspaceId, userId);
    if ((workspace as WorkspaceRecord & { isSystem?: boolean }).isSystem) {
      throw new AccessDeniedError('System workspaces cannot be deleted');
    }
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
    if ((workspace as WorkspaceRecord & { isSystem?: boolean }).isSystem) {
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
      throw new AccessDeniedError('Only Shared workspace owners can manage access');
    }
    if (role === 'owner') {
      throw new AccessDeniedError('Workspace ownership cannot be assigned through an invitation');
    }

    const grantRole = legacyWorkspaceRoleToNamedGrant(role);
    const canEdit = workspace.editingPolicy === 'direct'
      && (grantRole === 'publisher' || grantRole === 'contributor');
    await this.db.transaction(async (tx) => {
      await tx('workspace_members')
        .insert({ workspaceId, userId: targetUserId, role, canEdit })
        .onConflict(['workspaceId', 'userId'])
        .merge({ role, canEdit, updatedAt: tx.fn.now() });
      await tx('workspace_user_grants')
        .insert({
          workspaceId,
          userId: targetUserId,
          role: grantRole,
          grantedByUserId: actingUserId,
        })
        .onConflict(['workspaceId', 'userId'])
        .merge({ role: grantRole, grantedByUserId: actingUserId, updatedAt: tx.fn.now() });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.access_granted',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { targetUserId, role: grantRole },
      });
    });
  }

  async updateEditingPolicy(
    workspaceId: string,
    actingUserId: string,
    editingPolicy: 'direct' | 'review',
  ): Promise<void> {
    const { workspace, membership } = await this.ensureMembership(workspaceId, actingUserId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Only Shared workspaces have an editing policy');
    }
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only the workspace owner can change the editing policy');
    }

    await this.db.transaction(async (tx) => {
      await tx('workspaces').where({ id: workspaceId }).update({
        editingPolicy,
        updatedAt: tx.fn.now(),
      });
      await tx('workspace_members')
        .where({ workspaceId })
        .whereIn('role', ['editor', 'contributor'])
        .update({ canEdit: editingPolicy === 'direct', updatedAt: tx.fn.now() });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.editing_policy_changed',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { editingPolicy },
      });
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

    await this.db.transaction(async (tx) => {
      await tx('workspace_members').where({ workspaceId, userId: targetUserId }).del();
      await tx('workspace_user_grants').where({ workspaceId, userId: targetUserId }).del();
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.access_revoked',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { targetUserId, previousRole: legacyWorkspaceRoleToNamedGrant(target.role) },
      });
    });
  }

  async addTeamAccess(workspaceId: string, actingUserId: string, teamId: string): Promise<void> {
    const { membership } = await this.ensureMembership(workspaceId, actingUserId);
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (workspace?.visibility !== 'team') {
      throw new ConflictError('Private workspaces cannot have team access');
    }
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only Team owners can manage publishing access');
    }

    const team = await this.db('groups').where({ id: teamId }).first();
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    const actingTeamMembership = await this.db('group_members')
      .where({ groupId: teamId, userId: actingUserId })
      .first();
    if (!actingTeamMembership) {
      throw new AccessDeniedError('You must belong to the team before sharing with it');
    }
    if (workspace.teamId && workspace.teamId !== teamId) {
      throw new ConflictError('A shared workspace can only be connected to one team');
    }

    await this.db.transaction(async (tx) => {
      await tx('workspaces')
        .where({ id: workspaceId })
        .update({ teamId, updatedAt: tx.fn.now() });
      await tx('workspace_team_grants')
        .insert({
          workspaceId,
          teamId,
          role: 'viewer',
          grantedByUserId: actingUserId,
        })
        .onConflict(['workspaceId', 'teamId'])
        .merge({ role: 'viewer', grantedByUserId: actingUserId, updatedAt: tx.fn.now() });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.team_access_granted',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { teamId, role: 'viewer' },
      });
    });
  }

  async removeTeamAccess(workspaceId: string, actingUserId: string, teamId: string): Promise<void> {
    const { membership } = await this.ensureMembership(workspaceId, actingUserId);
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (workspace?.visibility !== 'team') {
      throw new ConflictError('Private workspaces cannot have team access');
    }
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only Team owners can manage publishing access');
    }
    if (workspace.teamId !== teamId) {
      throw new NotFoundError('Team access not found');
    }

    await this.db.transaction(async (tx) => {
      await tx('workspaces')
        .where({ id: workspaceId, teamId })
        .update({ teamId: null, updatedAt: tx.fn.now() });
      await tx('workspace_team_grants').where({ workspaceId, teamId }).del();
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.team_access_revoked',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { teamId },
      });
    });
  }

  async listCollaborators(
    workspaceId: string,
    userId: string,
  ): Promise<{
    collaborators: Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>;
    directCollaborators: Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>;
    teams: Array<{ id: string; name: string; role: 'viewer' | 'contributor' | 'publisher' }>;
  }> {
    const { workspace } = await this.ensureMembership(workspaceId, userId);
    const directCollaborators = await this.db('workspace_members')
      .join('users', 'workspace_members.userId', 'users.id')
      .select(
        'workspace_members.userId',
        'workspace_members.role',
        'workspace_members.canEdit',
        'users.displayName',
      )
      .where('workspace_members.workspaceId', workspaceId)
      .orderBy('users.displayName', 'asc');
    const directCollaboratorList = directCollaborators.map((row: any) => ({
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as WorkspaceRole,
      canEdit: Boolean(row.canEdit),
    }));
    const effectiveCollaborators = new Map(
      directCollaboratorList.map((collaborator) => [collaborator.userId, collaborator]),
    );
    if (workspace.teamId) {
      const groupMembers = await this.db('group_members')
        .join('users', 'group_members.userId', 'users.id')
        .select('group_members.userId', 'users.displayName')
        .where('group_members.groupId', workspace.teamId)
        .orderBy('users.displayName', 'asc');
      groupMembers.forEach((row: any) => {
        if (!effectiveCollaborators.has(row.userId)) {
          effectiveCollaborators.set(row.userId, {
            userId: row.userId,
            displayName: row.displayName,
            role: 'viewer',
            canEdit: false,
          });
        }
      });
    }

    const teams = workspace.teamId
      ? await buildWorkspaceTeamAccessQuery(this.db, workspaceId, workspace.teamId)
      : [];

    return {
      collaborators: Array.from(effectiveCollaborators.values()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName)),
      directCollaborators: directCollaboratorList,
      teams: teams.map((row: any) => ({
        id: row.id,
        name: row.name,
        role: row.role as 'viewer' | 'contributor' | 'publisher',
      })),
    };
  }

  async touchWorkspace(
    workspaceId: string,
    userId: string,
    options: { contentChanged?: boolean } = {},
  ): Promise<void> {
    const workspace = await this.db('workspaces')
      .where({ id: workspaceId })
      .select('ownerId', 'isSystem')
      .first();
    const lastModifiedBy = workspace?.isSystem && workspace.ownerId
      ? String(workspace.ownerId)
      : userId;
    await this.db('workspaces')
      .where({ id: workspaceId })
      .update({
        updatedAt: this.db.fn.now(),
        lastModifiedBy,
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
