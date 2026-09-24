import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { UserContext } from '../types/user';
import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import { legacyWorkspaceRoleToNamedGrant } from './workspaceAudiencePolicy';
import { isPlatformAdmin } from './governance/teamRoles';

const WORKSPACE_DIR = resolveWorkspaceRoot();

/**
 * How long a trashed workspace stays recoverable before the sweeper retires it.
 * Shared so the owner-initiated trash and the archive-on-deactivation path can
 * never drift to different windows.
 */
export const WORKSPACE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const workspacePurgeDeadline = (from: Date = new Date()): Date =>
  new Date(from.getTime() + WORKSPACE_TRASH_RETENTION_MS);

/**
 * Suppresses repeat audit rows for the same admin reading the same workspace.
 * Without it a single admin session writes one row per polled request, and an
 * audit trail nobody can read is the same as no audit trail at all.
 *
 * Module-scoped rather than an instance field on purpose: the test suite builds
 * services with `Object.create(WorkspaceService.prototype)`, which skips field
 * initializers and would leave a class-field Map undefined.
 */
const ADMIN_OVERRIDE_AUDIT_WINDOW_MS = 60_000;
const adminOverrideAuditSeenAt = new Map<string, number>();

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

/**
 * Why a workspace is in the trash. `user` is an owner-initiated delete;
 * `owner_deactivated` is an archive an admin caused by suspending the owner.
 * Reactivation restores only the second kind — restoring the first would
 * un-delete something the owner meant to throw away.
 */
export type WorkspaceTrashReason = 'user' | 'owner_deactivated';

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  commenter: 1,
  contributor: 2,
  editor: 3,
  owner: 4,
};

/**
 * Normalizes a database timestamp (Date, ISO string, or epoch number) into
 * epoch milliseconds. Returns null when the value is missing or unparseable so
 * callers can skip timestamp-based comparisons instead of treating them as 0.
 */
const toEpochMillis = (value: unknown): number | null => {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }
  return null;
};

export const strongestWorkspaceRole = (
  ...roles: Array<WorkspaceRole | null | undefined>
): WorkspaceRole => roles.reduce<WorkspaceRole>(
  (strongest, role) => role && WORKSPACE_ROLE_RANK[role] > WORKSPACE_ROLE_RANK[strongest]
    ? role
    : strongest,
  'viewer',
);

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  lastModifiedBy?: string | null;
  visibility: 'private' | 'team';
  workspaceType?: 'private' | 'team';
  editingPolicy?: 'direct' | 'review' | null;
  status?: 'active' | 'unshared' | 'trashed' | 'archived' | 'purged';
  unsharedAt?: string | Date | null;
  unsharedByUserId?: string | null;
  trashedAt?: string | Date | null;
  trashedByUserId?: string | null;
  trashReason?: WorkspaceTrashReason | null;
  purgeAfter?: string | Date | null;
  purgedAt?: string | Date | null;
  isSystem?: boolean;
  teamId?: string | null;
  currentPublishedVersionId?: string | null;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export const isSharedWorkspaceRecord = (workspace: Pick<WorkspaceRecord, 'visibility' | 'workspaceType'>): boolean => (
  workspace.workspaceType === 'team' || workspace.visibility === 'team'
);

/**
 * A purged workspace has passed its retention window. Its rows and object bytes
 * are deliberately retained so an operator can still restore it, which means
 * every read path has to hide it explicitly — it will not disappear on its own.
 * Shared here rather than re-derived per service so the file browser, the
 * workspace list and the access check cannot disagree about what "gone" means.
 */
export const isPurgedWorkspaceRecord = (workspace: Pick<WorkspaceRecord, 'status'>): boolean => (
  workspace.status === 'purged'
);

/**
 * Moves ownership of a Shared workspace onto `toUserId` inside an existing
 * transaction: the `workspaces.ownerId` column, the owner membership row, and
 * the publisher grant, with the outgoing owner demoted to editor.
 *
 * Module-level and transaction-scoped so the owner-initiated transfer and the
 * admin handover on deactivation run the same writes. Authorization is
 * deliberately *not* checked here — each caller owns its own guard (an owner may
 * only transfer their own workspace; an admin may only do so while deactivating
 * its owner), and folding both into one predicate would blur them.
 */
export async function applyWorkspaceOwnershipTransfer(
  tx: Knex.Transaction,
  params: {
    workspace: WorkspaceRecord;
    toUserId: string;
    actorUserId: string;
    reason?: string | null;
  },
): Promise<void> {
  const { workspace, toUserId, actorUserId } = params;
  const workspaceId = workspace.id;
  const previousOwnerUserId = workspace.ownerId;
  if (previousOwnerUserId === toUserId) return;

  // In Review mode the outgoing owner keeps read-only access, matching what any
  // other editor holds there; in Direct mode they keep editing.
  const formerOwnerCanEdit = workspace.editingPolicy === 'direct';

  await tx('workspaces').where({ id: workspaceId }).update({
    ownerId: toUserId,
    lastModifiedBy: actorUserId,
    updatedAt: tx.fn.now(),
  });
  await tx('workspace_members')
    .insert({ workspaceId, userId: toUserId, role: 'owner', canEdit: true })
    .onConflict(['workspaceId', 'userId'])
    .merge({ role: 'owner', canEdit: true, updatedAt: tx.fn.now() });
  await tx('workspace_members')
    .where({ workspaceId, userId: previousOwnerUserId })
    .update({ role: 'editor', canEdit: formerOwnerCanEdit, updatedAt: tx.fn.now() });
  await tx('workspace_user_grants')
    .insert({
      workspaceId,
      userId: toUserId,
      role: 'publisher',
      grantedByUserId: actorUserId,
    })
    .onConflict(['workspaceId', 'userId'])
    .merge({ role: 'publisher', grantedByUserId: actorUserId, updatedAt: tx.fn.now() });
  await tx('audit_events').insert({
    id: uuidv4(),
    actorUserId,
    actorRole: actorUserId === previousOwnerUserId ? 'workspace_owner' : 'platform_admin',
    action: 'workspace.ownership_transferred',
    resourceType: 'workspace',
    resourceId: workspaceId,
    platformOverride: actorUserId !== previousOwnerUserId,
    reason: params.reason?.trim() || null,
    metadata: { previousOwnerUserId, newOwnerUserId: toUserId },
  });
}

export interface AdminWorkspaceListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  visibility?: 'private' | 'team';
  ownerId?: string;
  /** Retired workspaces are hidden unless an operator asks for them by name. */
  includePurged?: boolean;
}

export interface AdminWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  visibility: 'private' | 'team';
  workspaceType: 'private' | 'team';
  status: string;
  editingPolicy: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerStatus: string;
  teamId: string | null;
  teamName: string | null;
  fileCount: number;
  memberCount: number;
  contentRevision: number;
  trashedAt: string | null;
  trashReason: WorkspaceTrashReason | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWorkspacePage {
  workspaces: AdminWorkspaceSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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
   * Lets a platform admin resolve access to a workspace they hold no membership
   * in, for oversight and support. What that grant is worth is derived from the
   * workspace itself, not from this flag — see `buildAdminOverrideMembership`.
   * In short: read-only everywhere except the platform's own system workspaces.
   * Every use that actually crosses a membership boundary is audited.
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
  editingPolicy: 'direct' | 'review' | null;
};

export class WorkspaceService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
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
    publicationStatus: 'private_draft' | 'up_to_date' | 'changes_to_publish' | 'withdrawn' | 'detached' | 'team_updates_available' | 'review_needed';
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
      .leftJoin('workspace_team_grants as wtg', function joinTeamGrant() {
        this.on('wtg.workspaceId', '=', 'w.id').andOn('wtg.teamId', '=', 'w.teamId');
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
        this.on('team_link.teamWorkspaceId', '=', 'w.id')
          .andOnVal('team_link.userId', '=', userId)
          .andOnVal('team_link.status', '=', 'active');
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
        'w.status',
        'w.unsharedAt',
        'w.unsharedByUserId',
        'w.trashedAt',
        'w.trashedByUserId',
        'w.purgeAfter',
        'w.teamId',
        'w.currentPublishedVersionId',
        'w.contentRevision',
        'w.createdAt',
        'w.updatedAt',
        'wm.role as directRole',
        'wm.canEdit as directCanEdit',
        'gm.userId as teamMemberUserId',
        'wtg.role as teamGrantRole',
        'g.name as teamName',
        'private_link.teamWorkspaceId as linkedTeamWorkspaceId',
        'linked_team.teamId as linkedTeamId',
        'linked_team.currentPublishedVersionId as linkedTeamCurrentPublishedVersionId',
        'linked_team.visibility as linkedTeamVisibility',
        'linked_team.status as linkedTeamStatus',
        'private_link.basePublishedVersionId',
        'private_link.status as publicationLinkStatus',
        'private_link.basePrivateContentRevision',
        'private_link.hasUnpublishedChanges',
        'linked_team.contentRevision as linkedTeamContentRevision',
        'linked_team.updatedAt as linkedTeamUpdatedAt',
        'private_link.baseSharedContentRevision',
        'private_link.updatedAt as publicationLinkUpdatedAt',
        'linked_team_member.role as linkedTeamRole',
        'linked_team_group_member.userId as linkedTeamGroupMemberUserId',
        'team_link.privateWorkspaceId as privateCopyWorkspaceId',
        'published.versionNumber as currentPublishedVersionNumber',
        'published.sourceContentRevision as publishedContentRevision',
        'published.createdAt as lastPublishedAt',
        'publisher.displayName as latestPublisherName',
        this.db.raw(`(
          SELECT MAX(f."updatedAt")
          FROM files AS f
          WHERE f."workspaceId" = private_link."teamWorkspaceId"
        ) as "linkedTeamFilesUpdatedAt"`),
        this.db.raw(`(
          SELECT COUNT(*)::int
          FROM workspace_published_versions AS version_history
          WHERE version_history."teamWorkspaceId" = w.id
        ) as "publishedVersionCount"`),
        this.db.raw(`(
          SELECT COUNT(*)::int
          FROM workspace_collaboration_objects AS collab
          WHERE collab."workspaceId" = w.id
            AND collab.type = 'change_proposal'
            AND collab.status IN ('proposed', 'discussing')
        ) as "pendingProposalCount"`),
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
                  .orWhere('w.ownerId', userId)
                  .orWhere((groupBackedQuery) => {
                    groupBackedQuery.whereNotNull('w.teamId').whereNotNull('gm.userId');
                  });
              });
          });
      })
      .andWhere('w.isSystem', false)
      // A whitelist, not a blacklist: `purged` rows are retained for recovery
      // and must never reappear here, including for the owner.
      .andWhere((statusQuery) => {
        statusQuery
          .where('w.status', 'active')
          .orWhere((ownerLifecycleQuery) => {
            ownerLifecycleQuery
              .where('w.ownerId', userId)
              .whereIn('w.status', ['unshared', 'trashed']);
          });
      })
      .orderBy('w.updatedAt', 'desc');

    return rows.map((row: any) => {
      const visibility = row.visibility === 'team' ? 'team' : 'private';
      const teamRole = row.teamMemberUserId
        ? row.teamGrantRole === 'contributor' ? 'contributor' : 'viewer'
        : null;
      const effectiveRole = visibility === 'private'
        ? 'owner'
        : strongestWorkspaceRole(row.directRole as WorkspaceRole | null, teamRole);
      const privateChanged = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && (
          Boolean(row.hasUnpublishedChanges)
          || Number(row.contentRevision || 0) !== Number(row.basePrivateContentRevision || 0)
        );
      const linkedTeamAccessible = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && (row.linkedTeamVisibility || 'team') === 'team'
        && (row.linkedTeamStatus || 'active') === 'active'
        && (row.publicationLinkStatus || 'active') === 'active'
        && (Boolean(row.linkedTeamRole) || Boolean(row.linkedTeamGroupMemberUserId));
      const linkedTeamDetached = visibility === 'private'
        && Boolean(row.linkedTeamWorkspaceId)
        && (
          (row.linkedTeamStatus || 'active') !== 'active'
          || (row.publicationLinkStatus || 'active') !== 'active'
          || !linkedTeamAccessible
        );
      const sharedContentRevisionKnown = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && row.baseSharedContentRevision != null
        && Number(row.baseSharedContentRevision) > 0;
      // Primary signal: the Shared Working copy moved past the revision this
      // draft was last synced with.
      const sharedRevisionChanged = sharedContentRevisionKnown
        ? Number(row.linkedTeamContentRevision || 0) !== Number(row.baseSharedContentRevision || 0)
        : String(row.linkedTeamCurrentPublishedVersionId || '') !== String(row.basePublishedVersionId || '');
      // Conservative legacy fallback: older Shared Working edits did not always
      // bump contentRevision, so a Shared workspace touched after the last
      // publication-link update still counts as an incoming change. Requires
      // both timestamps; a link without a timestamp never triggers this.
      // File-level updatedAt covers direct file insertions that do not bump
      // workspace revision or workspace updatedAt.
      const linkUpdatedAtMillis = toEpochMillis(row.publicationLinkUpdatedAt);
      const linkedTeamUpdatedAtMillis = toEpochMillis(row.linkedTeamUpdatedAt);
      const linkedTeamFilesUpdatedAtMillis = toEpochMillis(row.linkedTeamFilesUpdatedAt);
      const latestSharedTimestamp = Math.max(
        linkedTeamUpdatedAtMillis ?? 0,
        linkedTeamFilesUpdatedAtMillis ?? 0,
      ) || null;
      const sharedUpdatedAfterLink = linkUpdatedAtMillis != null
        && latestSharedTimestamp != null
        && latestSharedTimestamp > linkUpdatedAtMillis;
      const teamChanged = visibility === 'private'
        && row.linkedTeamWorkspaceId
        && linkedTeamAccessible
        && (sharedRevisionChanged || sharedUpdatedAfterLink);
      const needsInitialPublication = visibility === 'private'
        && Boolean(row.linkedTeamWorkspaceId)
        && !row.linkedTeamCurrentPublishedVersionId
        && !sharedContentRevisionKnown;
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
          : linkedTeamDetached
            ? 'detached'
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
        workspaceType: row.workspaceType === 'team' ? 'team' : 'private',
        editingPolicy: visibility === 'team' ? (row.editingPolicy || 'review') : null,
        status: row.status || 'active',
        unsharedAt: row.unsharedAt || null,
        unsharedByUserId: row.unsharedByUserId || null,
        trashedAt: row.trashedAt || null,
        trashedByUserId: row.trashedByUserId || null,
        purgeAfter: row.purgeAfter || null,
        teamId: row.teamId,
        currentPublishedVersionId: row.currentPublishedVersionId,
        contentRevision: Number(row.contentRevision || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        role: effectiveRole,
        canEdit: (row.status || 'active') !== 'trashed'
          && (visibility === 'private'
            || effectiveRole === 'owner'
            || effectiveRole === 'editor'
            || effectiveRole === 'contributor'),
        canPublish: (row.status || 'active') === 'active'
          && visibility === 'team'
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
        pendingProposalCount: visibility === 'team'
          ? Number(row.pendingProposalCount || 0)
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

  /**
   * Every workspace on the platform, for the admin oversight page.
   *
   * Written fresh rather than as a variant of `listWorkspacesForUser`: that
   * query exists to answer "what can this person reach", and carries a large
   * publication-state join to do it. This one answers "what exists", which is
   * the opposite filter and needs none of that. Bending one query to serve both
   * would make the membership rules harder to read, which is the last thing an
   * authorization query should be.
   *
   * Metadata only — no file or conversation content is touched here.
   */
  async listAllWorkspacesForAdmin(options: AdminWorkspaceListOptions = {}): Promise<AdminWorkspacePage> {
    const page = Math.max(1, Math.floor(options.page || 1));
    const pageSize = Math.min(100, Math.max(5, Math.floor(options.pageSize || 25)));
    const search = options.search?.trim() || '';

    const applyFilters = <T extends Knex.QueryBuilder>(query: T): T => {
      query.where('w.isSystem', false);
      if (!options.includePurged) {
        query.whereNot('w.status', 'purged');
      }
      if (options.status) {
        query.where('w.status', options.status);
      }
      if (options.visibility) {
        query.where('w.visibility', options.visibility);
      }
      if (options.ownerId) {
        query.where('w.ownerId', options.ownerId);
      }
      if (search) {
        // Same escaping as `UserService.listUsersPage`: an unescaped `%` or `_`
        // in a search box would otherwise act as a wildcard.
        const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        const pattern = `%${escaped}%`;
        query.where((builder) => {
          builder
            .where('w.name', 'ilike', pattern)
            .orWhere('owner.displayName', 'ilike', pattern)
            .orWhere('owner.email', 'ilike', pattern);
        });
      }
      return query;
    };

    const countRow = await applyFilters(
      this.db('workspaces as w').leftJoin('users as owner', 'owner.id', 'w.ownerId'),
    ).count<{ count: string }>('w.id as count').first();
    const total = Number(countRow?.count || 0);

    const rows = await applyFilters(
      this.db('workspaces as w')
        .leftJoin('users as owner', 'owner.id', 'w.ownerId')
        .leftJoin('groups as team', 'team.id', 'w.teamId'),
    )
      .select(
        'w.id', 'w.name', 'w.slug', 'w.visibility', 'w.workspaceType', 'w.status',
        'w.editingPolicy', 'w.ownerId', 'w.teamId', 'w.contentRevision',
        'w.trashedAt', 'w.trashReason', 'w.purgeAfter', 'w.purgedAt',
        'w.createdAt', 'w.updatedAt',
        'owner.displayName as ownerName', 'owner.email as ownerEmail', 'owner.status as ownerStatus',
        'team.name as teamName',
        this.db.raw('(SELECT count(*) FROM files WHERE files."workspaceId" = w.id AND files."deletedAt" IS NULL) as "fileCount"'),
        this.db.raw('(SELECT count(*) FROM workspace_members WHERE workspace_members."workspaceId" = w.id) as "memberCount"'),
      )
      .orderBy('w.updatedAt', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize) as Array<Record<string, unknown>>;

    return {
      workspaces: rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        visibility: row.visibility === 'team' ? 'team' : 'private',
        workspaceType: row.workspaceType === 'team' ? 'team' : 'private',
        status: String(row.status || 'active'),
        editingPolicy: (row.editingPolicy as string | null) ?? null,
        ownerId: (row.ownerId as string | null) ?? null,
        ownerName: (row.ownerName as string | null) ?? null,
        ownerEmail: (row.ownerEmail as string | null) ?? null,
        ownerStatus: (row.ownerStatus as string | null) ?? 'active',
        teamId: (row.teamId as string | null) ?? null,
        teamName: (row.teamName as string | null) ?? null,
        fileCount: Number(row.fileCount || 0),
        memberCount: Number(row.memberCount || 0),
        contentRevision: Number(row.contentRevision || 0),
        trashedAt: (row.trashedAt as string | null) ?? null,
        trashReason: (row.trashReason as WorkspaceTrashReason | null) ?? null,
        purgeAfter: (row.purgeAfter as string | null) ?? null,
        purgedAt: (row.purgedAt as string | null) ?? null,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * Conversations in a workspace, for admin oversight.
   *
   * `ConversationService` deliberately scopes every read to `createdBy = userId`
   * — a conversation is personal to the person who had it — so it is the wrong
   * place to relax. This is a separate, explicitly-admin path rather than a flag
   * threaded through that one, so nothing on the normal user path can ever
   * accidentally widen.
   */
  async listConversationsForAdmin(
    workspaceId: string,
    adminUserId: string,
  ): Promise<Array<{
    id: string;
    persona: string | null;
    createdBy: string | null;
    authorName: string | null;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  }>> {
    await this.ensureMembership(workspaceId, adminUserId, { allowSystemAdmin: true });
    const rows = await this.db('conversations as c')
      .leftJoin('users as author', 'author.id', 'c.createdBy')
      .where('c.workspaceId', workspaceId)
      .select(
        'c.id', 'c.persona', 'c.createdBy', 'c.createdAt', 'c.updatedAt',
        'author.displayName as authorName',
        this.db.raw('(SELECT count(*) FROM conversation_messages m WHERE m."conversationId" = c.id) as "messageCount"'),
      )
      .orderBy('c.updatedAt', 'desc') as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      persona: (row.persona as string | null) ?? null,
      createdBy: (row.createdBy as string | null) ?? null,
      authorName: (row.authorName as string | null) ?? null,
      messageCount: Number(row.messageCount || 0),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }));
  }

  async readConversationForAdmin(
    workspaceId: string,
    conversationId: string,
    adminUserId: string,
  ): Promise<{ conversation: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null> {
    await this.ensureMembership(workspaceId, adminUserId, { allowSystemAdmin: true });
    const conversation = await this.db('conversations')
      .where({ id: conversationId, workspaceId })
      .first();
    if (!conversation) return null;
    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');
    return { conversation, messages };
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

    // A purged workspace still has rows and bytes so an operator can restore it,
    // which means it has to be hidden explicitly rather than by absence.
    if (isPurgedWorkspaceRecord(normalizedWorkspace)) {
      throw new NotFoundError('Workspace not found');
    }
    if (normalizedWorkspace.status === 'trashed') {
      throw new NotFoundError('Workspace is in trash');
    }
    if (
      (normalizedWorkspace.status === 'unshared' || normalizedWorkspace.status === 'archived')
      && normalizedWorkspace.ownerId !== userId
    ) {
      throw new AccessDeniedError('This Shared workspace is no longer shared');
    }

    // A workspace owner always has full access to their own workspace, regardless of
    // visibility or team membership (owners should never be locked out of what they own).
    // This is resolved before any override so an owner is never recorded as one.
    if (normalizedWorkspace.ownerId === userId) {
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

    // `isPlatformAdmin` rather than a bare `users.isAdmin` lookup: the governance
    // services already treat a `platform_role_bindings` row as equivalent, and two
    // definitions of "admin" that can disagree is not a distinction worth keeping.
    const adminOverride = options.allowSystemAdmin && await isPlatformAdmin(this.db, userId)
      ? this.buildAdminOverrideMembership(normalizedWorkspace, userId)
      : null;

    // A private workspace is an owner-only boundary for everyone except a
    // platform admin exercising oversight, whose reach is read-only and audited.
    if (normalizedWorkspace.visibility === 'private' && !adminOverride) {
      throw new AccessDeniedError('Private workspace access denied');
    }

    const directMembership = await this.db<WorkspaceMembershipRecord>('workspace_members')
      .where({ workspaceId, userId })
      .first();

    let membership = directMembership;
    if (normalizedWorkspace.teamId) {
      const groupMembership = await this.db('group_members')
        .where({ groupId: normalizedWorkspace.teamId, userId })
        .first();
      if (!groupMembership && !membership && !adminOverride) {
        throw new AccessDeniedError('Team membership is required to access this workspace');
      }
      if (groupMembership) {
        const teamGrant = await this.db('workspace_team_grants')
          .where({ workspaceId, teamId: normalizedWorkspace.teamId })
          .first();
        const teamRole: WorkspaceRole = teamGrant?.role === 'contributor' ? 'contributor' : 'viewer';
        const effectiveRole = strongestWorkspaceRole(membership?.role, teamRole);
        membership = {
          workspaceId,
          userId,
          role: effectiveRole,
          canEdit: false,
          createdAt: membership?.createdAt || groupMembership.createdAt,
          updatedAt: membership?.updatedAt || groupMembership.updatedAt,
        };
      }
    }

    // Only now, with every real route to this workspace exhausted, does the
    // override apply. An admin who holds a genuine membership resolves through
    // it above and is not treated — or audited — as an override.
    let usingAdminOverride = false;
    if (!membership) {
      if (!adminOverride) {
        throw new AccessDeniedError('Workspace access denied');
      }
      membership = adminOverride;
      usingAdminOverride = true;
      await this.recordAdminOverrideAccess(normalizedWorkspace, userId);
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
      canEdit: usingAdminOverride ? adminOverride!.canEdit : roleCanEditShared,
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

    const isSharedFreeflow = workspacePolicy?.visibility === 'team'
      && workspacePolicy.editingPolicy === 'direct';

    return {
      mcpServerAllowIds: Array.from(new Set(allow)).sort(),
      mcpServerDenyIds: Array.from(new Set(deny)).sort(),
      isAdmin,
      skipPlanApprovals: Boolean(workspacePolicy?.skipPlanApprovals),
      workspaceMode: workspacePolicy?.visibility === 'team' ? 'shared_live' : 'private',
      workspaceRole: membership.role,
      canWriteWorkspace: workspacePolicy?.visibility !== 'team'
        ? membership.canEdit
        : isSharedFreeflow && membership.canEdit,
      editingPolicy: workspacePolicy?.visibility === 'team'
        ? (workspacePolicy.editingPolicy === 'direct' ? 'direct' : 'review')
        : null,
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

    if (isSharedWorkspaceRecord(workspace)) {
      await this.db.transaction(async (tx) => {
        const lockedWorkspace = await tx<WorkspaceRecord>('workspaces')
          .where({ id: workspaceId })
          .forUpdate()
          .first();
        if (!lockedWorkspace) throw new NotFoundError('Workspace not found');
        if (!isSharedWorkspaceRecord(lockedWorkspace)) {
          throw new ConflictError('Workspace is no longer Shared');
        }
        if (lockedWorkspace.ownerId !== userId) {
          throw new AccessDeniedError('Only workspace owners can delete a workspace');
        }
        if (lockedWorkspace.status === 'trashed') return;
        await tx('workspaces').where({ id: workspaceId }).update({
          status: 'trashed',
          trashedAt: tx.fn.now(),
          trashedByUserId: userId,
          trashReason: 'user',
          purgeAfter: workspacePurgeDeadline(),
          updatedAt: tx.fn.now(),
          lastModifiedBy: userId,
        });
        await tx('workspace_publication_links').where({ teamWorkspaceId: workspaceId }).update({
          status: 'detached',
          detachedAt: tx.fn.now(),
          reconnectToken: null,
          updatedAt: tx.fn.now(),
        });
        await this.recordWorkspaceLifecycleAudit(tx, workspaceId, userId, 'workspace.trashed');
      });
      return;
    }

    await this.performWorkspaceDeletion(workspace.id);
  }

  async unshareWorkspace(workspaceId: string, actingUserId: string): Promise<void> {
    await this.ensureMembership(workspaceId, actingUserId);

    await this.db.transaction(async (tx) => {
      const workspace = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!workspace) throw new NotFoundError('Workspace not found');
      if (!isSharedWorkspaceRecord(workspace)) {
        throw new ConflictError('Only Shared workspaces can be unshared');
      }
      if (workspace.ownerId !== actingUserId) {
        throw new AccessDeniedError('Only the Shared workspace owner can unshare it');
      }
      if (workspace.status === 'trashed') {
        throw new ConflictError('Restore the Shared workspace before unsharing it');
      }
      if (workspace.status === 'unshared') return;
      await tx('workspaces').where({ id: workspaceId }).update({
        status: 'unshared',
        unsharedAt: tx.fn.now(),
        unsharedByUserId: actingUserId,
        updatedAt: tx.fn.now(),
        lastModifiedBy: actingUserId,
      });
      await tx('workspace_publication_links').where({ teamWorkspaceId: workspaceId }).update({
        status: 'detached',
        detachedAt: tx.fn.now(),
        reconnectToken: null,
        updatedAt: tx.fn.now(),
      });
      await this.recordWorkspaceLifecycleAudit(tx, workspaceId, actingUserId, 'workspace.unshared');
    });
  }

  async reshareWorkspace(workspaceId: string, actingUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workspace = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!workspace) throw new NotFoundError('Workspace not found');
      if (!isSharedWorkspaceRecord(workspace)) throw new ConflictError('Only Shared workspaces can be reshared');
      if (workspace.ownerId !== actingUserId) {
        throw new AccessDeniedError('Only the Shared workspace owner can reshare it');
      }
      if (workspace.status === 'trashed') {
        throw new ConflictError('Restore the Shared workspace before resharing it');
      }
      if ((workspace.status || 'active') === 'active') return;
      await tx('workspaces').where({ id: workspaceId }).update({
        status: 'active',
        unsharedAt: null,
        unsharedByUserId: null,
        updatedAt: tx.fn.now(),
        lastModifiedBy: actingUserId,
      });
      await this.recordWorkspaceLifecycleAudit(tx, workspaceId, actingUserId, 'workspace.reshared');
    });
  }

  async restoreWorkspace(workspaceId: string, actingUserId: string): Promise<void> {
    const restoredStatus = 'unshared';

    await this.db.transaction(async (tx) => {
      const workspace = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!workspace) throw new NotFoundError('Workspace not found');
      if (!isSharedWorkspaceRecord(workspace)) {
        throw new ConflictError('Only trashed Shared workspaces can be restored');
      }
      if (workspace.ownerId !== actingUserId) {
        throw new AccessDeniedError('Only the Shared workspace owner can restore it');
      }
      if (workspace.status !== 'trashed') return;
      await tx('workspaces').where({ id: workspaceId }).update({
        status: restoredStatus,
        unsharedAt: workspace.unsharedAt || tx.fn.now(),
        unsharedByUserId: workspace.unsharedByUserId || actingUserId,
        trashedAt: null,
        trashedByUserId: null,
        purgeAfter: null,
        updatedAt: tx.fn.now(),
        lastModifiedBy: actingUserId,
      });
      await this.recordWorkspaceLifecycleAudit(tx, workspaceId, actingUserId, 'workspace.restored', {
        restoredStatus,
      });
    });
  }

  async leaveWorkspace(workspaceId: string, userId: string): Promise<void> {
    await this.ensureMembership(workspaceId, userId);

    await this.db.transaction(async (tx) => {
      const workspace = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!workspace) throw new NotFoundError('Workspace not found');
      if (!isSharedWorkspaceRecord(workspace) || workspace.status !== 'active') {
        throw new ConflictError('Only active Shared workspace access can be left');
      }
      if (workspace.ownerId === userId) {
        throw new ConflictError('Transfer ownership before leaving this workspace');
      }
      const directMembership = await tx('workspace_members').where({ workspaceId, userId }).first();
      if (!directMembership) throw new NotFoundError('No direct workspace access to leave');
      if (workspace.teamId) {
        const teamMembership = await tx('group_members').where({
          groupId: workspace.teamId,
          userId,
        }).first();
        if (teamMembership) {
          throw new ConflictError('Access is managed by your Team. Leave the Team to leave this workspace.');
        }
      }
      await tx('workspace_members').where({ workspaceId, userId }).del();
      await tx('workspace_user_grants').where({ workspaceId, userId }).del();
      await tx('workspace_publication_links')
        .where({ teamWorkspaceId: workspaceId, userId })
        .update({ status: 'detached', detachedAt: tx.fn.now(), reconnectToken: null, updatedAt: tx.fn.now() });
      await this.recordWorkspaceLifecycleAudit(tx, workspaceId, userId, 'workspace.left', {}, 'workspace_member');
    });
  }

  async transferWorkspaceOwnership(
    workspaceId: string,
    actingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.ensureMembership(workspaceId, actingUserId);
    if (targetUserId === actingUserId) return;
    const targetUser = await this.db('users').where({ id: targetUserId }).first();
    if (!targetUser) throw new NotFoundError('New owner not found');

    await this.db.transaction(async (tx) => {
      const workspace = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!workspace) throw new NotFoundError('Workspace not found');
      if (!isSharedWorkspaceRecord(workspace)) {
        throw new ConflictError('Only Shared workspace ownership can be transferred');
      }
      if (workspace.ownerId !== actingUserId) {
        throw new AccessDeniedError('Only the Shared workspace owner can transfer ownership');
      }
      if (workspace.status === 'trashed') {
        throw new ConflictError('Restore the Shared workspace before transferring ownership');
      }
      await applyWorkspaceOwnershipTransfer(tx, {
        workspace,
        toUserId: targetUserId,
        actorUserId: actingUserId,
      });
    });
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
    const { workspace, membership } = await this.ensureMembership(workspaceId, actingUserId);
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

    const retainsTeamAccess = Boolean(workspace?.teamId && await this.db('group_members').where({
      groupId: workspace.teamId,
      userId: targetUserId,
    }).first());
    await this.db.transaction(async (tx) => {
      await tx('workspace_members').where({ workspaceId, userId: targetUserId }).del();
      await tx('workspace_user_grants').where({ workspaceId, userId: targetUserId }).del();
      if (!retainsTeamAccess) {
        await tx('workspace_publication_links')
          .where({ teamWorkspaceId: workspaceId, userId: targetUserId })
          .update({ status: 'detached', detachedAt: tx.fn.now(), reconnectToken: null, updatedAt: tx.fn.now() });
      }
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

  async addTeamAccess(
    workspaceId: string,
    actingUserId: string,
    teamId: string,
    role: 'contributor' | 'viewer' = 'viewer',
  ): Promise<void> {
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
          role,
          grantedByUserId: actingUserId,
        })
        .onConflict(['workspaceId', 'teamId'])
        .merge({ role, grantedByUserId: actingUserId, updatedAt: tx.fn.now() });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actingUserId,
        actorRole: 'workspace_owner',
        action: 'workspace.team_access_granted',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { teamId, role },
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
      const teamOnlyLinks = await tx('workspace_publication_links as link')
        .leftJoin('workspace_members as direct', function joinDirectWorkspaceAccess() {
          this.on('direct.workspaceId', '=', 'link.teamWorkspaceId')
            .andOn('direct.userId', '=', 'link.userId');
        })
        .where('link.teamWorkspaceId', workspaceId)
        .whereNull('direct.userId')
        .select('link.privateWorkspaceId') as Array<{ privateWorkspaceId: string }>;
      const detachedPrivateWorkspaceIds = teamOnlyLinks.map((link) => String(link.privateWorkspaceId));
      if (detachedPrivateWorkspaceIds.length) {
        await tx('workspace_publication_links')
          .whereIn('privateWorkspaceId', detachedPrivateWorkspaceIds)
          .update({
            status: 'detached',
            detachedAt: tx.fn.now(),
            reconnectToken: null,
            updatedAt: tx.fn.now(),
          });
      }
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
    options: MembershipCheckOptions = {},
  ): Promise<{
    collaborators: Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>;
    directCollaborators: Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>;
    teams: Array<{ id: string; name: string; role: 'viewer' | 'contributor' }>;
  }> {
    // Read-only, so the admin oversight page can pass the override here. The
    // mutating collaborator methods deliberately do not accept it.
    const { workspace } = await this.ensureMembership(workspaceId, userId, options);
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
    const teams = workspace.teamId
      ? await buildWorkspaceTeamAccessQuery(this.db, workspaceId, workspace.teamId) as Array<{
          id: string;
          name: string;
          role: 'viewer' | 'contributor';
        }>
      : [];
    if (workspace.teamId) {
      const teamRole: WorkspaceRole = teams[0]?.role === 'contributor' ? 'contributor' : 'viewer';
      const groupMembers = await this.db('group_members')
        .join('users', 'group_members.userId', 'users.id')
        .select('group_members.userId', 'users.displayName')
        .where('group_members.groupId', workspace.teamId)
        .orderBy('users.displayName', 'asc');
      groupMembers.forEach((row: any) => {
        const direct = effectiveCollaborators.get(row.userId);
        const role = strongestWorkspaceRole(direct?.role, teamRole);
        effectiveCollaborators.set(row.userId, {
          userId: row.userId,
          displayName: row.displayName,
          role,
          canEdit: role === 'owner' || (
            workspace.editingPolicy === 'direct'
            && (role === 'editor' || role === 'contributor')
          ),
        });
      });
    }

    return {
      collaborators: Array.from(effectiveCollaborators.values()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName)),
      directCollaborators: directCollaboratorList,
      teams: teams.map((row: any) => ({
        id: row.id,
        name: row.name,
        role: row.role === 'contributor' ? 'contributor' as const : 'viewer' as const,
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

  /**
   * What a platform-admin override is actually worth, derived from the workspace
   * record rather than from the caller's intent (a per-call-site flag is only as
   * correct as the enumeration of call sites, and this codebase has repeatedly
   * had one more than expected).
   *
   * Only the platform's own system workspaces — the Knowledge Library storage,
   * owned by a system identity and reachable by no other route — grant write.
   * Every workspace a real person owns resolves to `viewer`/`canEdit: false`, so
   * an override can read for oversight but can never mutate someone's content.
   */
  private buildAdminOverrideMembership(
    workspace: WorkspaceRecord,
    userId: string,
  ): WorkspaceMembershipRecord {
    const canManage = Boolean(workspace.isSystem);
    return {
      workspaceId: workspace.id,
      userId,
      role: canManage ? 'owner' : 'viewer',
      canEdit: canManage,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  /**
   * Records that an admin reached into a workspace they are not a member of.
   * System workspaces are skipped: that is platform plumbing on a workspace no
   * person owns, not a crossing of anyone's privacy boundary.
   */
  private async recordAdminOverrideAccess(
    workspace: WorkspaceRecord,
    actorUserId: string,
  ): Promise<void> {
    if (workspace.isSystem) return;

    const key = `${actorUserId}:${workspace.id}`;
    const now = Date.now();
    const lastSeenAt = adminOverrideAuditSeenAt.get(key);
    if (lastSeenAt && now - lastSeenAt < ADMIN_OVERRIDE_AUDIT_WINDOW_MS) return;
    adminOverrideAuditSeenAt.set(key, now);
    for (const [seenKey, seenAt] of adminOverrideAuditSeenAt) {
      if (now - seenAt >= ADMIN_OVERRIDE_AUDIT_WINDOW_MS) adminOverrideAuditSeenAt.delete(seenKey);
    }

    try {
      await this.db('audit_events').insert({
        id: uuidv4(),
        actorUserId,
        actorRole: 'platform_admin',
        action: 'admin.workspace.accessed',
        resourceType: 'workspace',
        resourceId: workspace.id,
        platformOverride: true,
        metadata: {
          visibility: workspace.visibility,
          workspaceType: workspace.workspaceType || null,
          ownerId: workspace.ownerId,
          workspaceName: workspace.name,
        },
      });
    } catch (error) {
      // An oversight read must not fail because its audit row could not be
      // written, but a silent gap in the trail is worth shouting about.
      console.error('Failed to record admin workspace override access', {
        workspaceId: workspace.id,
        actorUserId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  private async recordWorkspaceLifecycleAudit(
    tx: Knex.Transaction,
    workspaceId: string,
    actorUserId: string,
    action: string,
    metadata: Record<string, unknown> = {},
    actorRole = 'workspace_owner',
  ): Promise<void> {
    await tx('audit_events').insert({
      id: uuidv4(),
      actorUserId,
      actorRole,
      action,
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata,
    });
  }

  private async createWorkspaceDirectory(workspaceId: string): Promise<void> {
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    await fs.mkdir(workspacePath, { recursive: true });
  }

  async cleanupWorkspaceArtifacts(workspaceId: string): Promise<void> {
    await this.performWorkspaceCleanup(workspaceId);
  }

  /**
   * Retires expired trashed workspaces in a bounded batch. `FOR UPDATE SKIP
   * LOCKED` lets every API pod run the same sweep without double-purging.
   *
   * This deliberately does **not** delete anything. The row is marked `purged`
   * and every read path hides it, but the rows, the local mirror and the object
   * bytes all survive so an operator can still restore the workspace — see
   * `scripts/restore-purged-workspace.ts`. Wiping the workspace directory here
   * would make that promise false for locally-stored files (`files.storageType
   * === 'local'`), which exist nowhere else. Actual destruction is a separate,
   * explicit, operator-run step: `scripts/hard-purge-workspace.ts`.
   */
  async purgeExpiredTrashedWorkspaces(limit = 25): Promise<string[]> {
    const batchSize = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db.transaction(async (tx) => {
      const workspaces = await tx('workspaces')
        .select('id', 'ownerId', 'name', 'trashReason')
        .where({ status: 'trashed', isSystem: false })
        .whereNotNull('purgeAfter')
        .andWhere('purgeAfter', '<=', tx.fn.now())
        .orderBy('purgeAfter', 'asc')
        .forUpdate()
        .skipLocked()
        .limit(batchSize) as Array<{
          id: string; ownerId: string; name: string; trashReason: string | null;
        }>;
      const workspaceIds = workspaces.map((workspace) => String(workspace.id));
      if (!workspaceIds.length) return workspaceIds;

      await tx('workspaces').whereIn('id', workspaceIds).update({
        status: 'purged',
        purgedAt: tx.fn.now(),
        purgeAfter: null,
        updatedAt: tx.fn.now(),
      });

      await tx('audit_events').insert(workspaces.map((workspace) => ({
        id: uuidv4(),
        actorUserId: null,
        actorRole: 'system',
        action: 'workspace.purged',
        resourceType: 'workspace',
        resourceId: String(workspace.id),
        metadata: {
          workspaceName: workspace.name,
          ownerId: workspace.ownerId,
          trashReason: workspace.trashReason || null,
          recoverable: true,
        },
      })));

      return workspaceIds;
    });
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
    // Immutable file versions may be referenced by publications or another
    // workspace. Durable objects are retained until reference-aware GC exists.
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
