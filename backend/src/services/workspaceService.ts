import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { UserContext } from '../types/user';
import { AccessDeniedError, ConflictError, NotFoundError, WorkspaceContentLockedError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import {
  legacyWorkspaceRoleToNamedGrant,
  namedGrantToLegacyWorkspaceRole,
  type WorkspaceNamedGrantRole,
} from './workspaceAudiencePolicy';
import { getWorkspaceRoleCapabilities } from './workspaceCollaborationPolicy';
import { isPlatformAdmin } from './governance/teamRoles';
import { detachUnreachablePublicationLinks } from './workspaceTeamReach';

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

/**
 * Every team that can reach this workspace, with the role each one carries.
 *
 * `workspace_team_grants` is keyed `(workspaceId, teamId)` and has always held
 * as many teams as you like — the single-team limit lived in `workspaces.teamId`,
 * which this reads in place of.
 */
export function buildWorkspaceTeamAccessQuery(db: Knex, workspaceId: string) {
  return db('workspace_team_grants as workspaceTeamGrant')
    .join('groups as group', 'group.id', 'workspaceTeamGrant.teamId')
    .where('workspaceTeamGrant.workspaceId', workspaceId)
    .orderBy('group.name', 'asc')
    .select(
      'group.id',
      'group.name',
      db.raw(`COALESCE("workspaceTeamGrant"."role", 'viewer') as role`),
    );
}

/**
 * Rank a team grant in SQL, for picking the strongest without joining.
 *
 * Joining the grants in would fan the row out once per (membership × grant), and
 * `DISTINCT` cannot collapse that — the columns that differ, the role and the
 * team name, are the ones being selected. A ranked subquery keeps it one row.
 *
 * This duplicates `WORKSPACE_ROLE_RANK` in SQL, so the two are pinned together
 * by a test. Every reader uses this constant rather than its own copy of the
 * `CASE`: the list query carried a hand-written duplicate, which would have
 * ranked a publisher grant as a viewer the moment a third tier existed.
 *
 * Ranks the stored spelling. `workspace_team_grants.role` holds the named-grant
 * vocabulary, the same as `workspace_user_grants`, so the strongest tier is
 * `publisher` rather than the `editor` it resolves to.
 */
const TEAM_GRANT_RANK_SQL = `CASE "role" WHEN 'publisher' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END`;

/**
 * The effective roles a team grant may resolve to, strongest first.
 *
 * `editor` — Publisher — is reachable through a team. It was once direct-user
 * only, on the reasoning that release authority needs a named individual behind
 * it. Every publication already records one: `publisherUserId` on the version,
 * `publishedByUserId` on a file publication, and an audit event. What the
 * restriction actually bought was consent rather than traceability, and it cost
 * the consistency of having one role a team could never hold.
 */
export const TEAM_GRANT_ROLES: WorkspaceRole[] = ['editor', 'contributor', 'viewer'];

/** The spellings `workspace_team_grants.role` may hold, strongest first. */
export const TEAM_GRANT_STORED_ROLES: WorkspaceNamedGrantRole[] = ['publisher', 'contributor', 'viewer'];

/**
 * The strongest role `userId` holds on `workspaceId` through any of their teams,
 * or null when no team of theirs holds a grant.
 */
export async function resolveTeamGrantRole(
  db: Knex,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const grant = await db('workspace_team_grants as tg')
    .join('group_members as gm', function joinMembership() {
      this.on('gm.groupId', '=', 'tg.teamId').andOnVal('gm.userId', '=', userId);
    })
    .where('tg.workspaceId', workspaceId)
    .orderByRaw(`${TEAM_GRANT_RANK_SQL} DESC, tg."teamId" ASC`)
    .select('tg.role')
    .first();
  if (!grant) return null;
  return storedTeamGrantRole(grant.role);
}

/**
 * Read a stored team grant as the role it grants.
 *
 * Fails closed: anything outside the vocabulary reads as `viewer` rather than
 * being honoured, so a hand-written row cannot mint authority. That mattered
 * more when `publisher` was unreachable, and it still decides what an older or
 * mistyped row means.
 */
export const storedTeamGrantRole = (role: unknown): WorkspaceRole =>
  namedGrantToLegacyWorkspaceRole(namedTeamGrantRole(role));

/**
 * The same read, in the named-grant vocabulary the sharing API speaks.
 *
 * Callers returning a role to the client need `publisher`, not the `editor` it
 * resolves to internally. Both readers go through this one list, because the
 * two that did not — a pair of `role === 'contributor' ? … : 'viewer'`
 * ternaries written when a team could only be a contributor or a viewer —
 * reported a publisher team as "Viewer access" and folded its members in with
 * a viewer's `canEdit`.
 */
export const namedTeamGrantRole = (role: unknown): WorkspaceNamedGrantRole => {
  const stored = String(role || '').trim();
  if (!TEAM_GRANT_STORED_ROLES.includes(stored as WorkspaceNamedGrantRole)) return 'viewer';
  return stored as WorkspaceNamedGrantRole;
};

/**
 * Whether someone may give up their own access to a workspace, and if not, why.
 *
 * Leaving removes a direct grant. If the caller also reaches the workspace
 * through a team, removing that grant changes nothing — they are still in the
 * team — so the action is refused rather than offered and silently ignored.
 *
 * Returns a reason rather than a bare boolean so the endpoint keeps its four
 * distinct messages while the sidebar reads one flag. Both go through this
 * function, which is what stops the button and the endpoint disagreeing: the
 * client used to read a cached `audienceType` label describing the *workspace*
 * while the server asked a live question about the *person*.
 */
export type WorkspaceLeaveRefusalReason =
  | 'not_shared'
  | 'owner'
  | 'no_direct_access'
  | 'team_managed';

export type WorkspaceLeaveVerdict =
  | { canLeave: true }
  | { canLeave: false; reason: WorkspaceLeaveRefusalReason };

export const resolveWorkspaceLeaveVerdict = (input: {
  isShared: boolean;
  status?: WorkspaceRecord['status'];
  isOwner: boolean;
  hasDirectMembership: boolean;
  reachesViaTeam: boolean;
}): WorkspaceLeaveVerdict => {
  // Clause order matches `leaveWorkspace`, so the same situation still produces
  // the same message (`LEARNINGS.md` §13).
  if (!input.isShared || (input.status || 'active') !== 'active') {
    return { canLeave: false, reason: 'not_shared' };
  }
  if (input.isOwner) return { canLeave: false, reason: 'owner' };
  if (!input.hasDirectMembership) return { canLeave: false, reason: 'no_direct_access' };
  if (input.reachesViaTeam) return { canLeave: false, reason: 'team_managed' };
  return { canLeave: true };
};

/** The error each refusal has always raised. Wording is deliberately unchanged. */
export const workspaceLeaveRefusal = (reason: WorkspaceLeaveRefusalReason): Error => {
  if (reason === 'not_shared') return new ConflictError('Only active Shared workspace access can be left');
  if (reason === 'owner') return new ConflictError('Transfer ownership before leaving this workspace');
  if (reason === 'no_direct_access') return new NotFoundError('No direct workspace access to leave');
  return new ConflictError('Access is managed by your Team. Leave the Team to leave this workspace.');
};

/**
 * Whether `userId` still reaches `workspaceId` through any team.
 *
 * Used wherever revoking one route must not assume it was the only one — the
 * detach paths previously asked "is there a direct membership?" and treated its
 * absence as "team access is gone", which was true only while a workspace could
 * hold one team.
 */
export async function hasTeamDerivedAccess(
  db: Knex,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return Boolean(await resolveTeamGrantRole(db, workspaceId, userId));
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
  /**
   * Vestigial. Team access comes from `workspace_team_grants`; no code reads
   * this to decide anything. Still selected so the row shape matches the table
   * while the column exists, and dropped with it in a later deploy.
   */
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
 * A Shared workspace holding a current locked version is read-only for direct
 * content edits — for everyone, its owner included.
 *
 * Locking used to be a pure bookkeeping act: it wrote an immutable snapshot and
 * moved `currentPublishedVersionId`, while the live workspace stayed as writable
 * as it had been a moment earlier. Users read "locked" as "locked", edited
 * anyway, and then had nowhere to send the result — the review flow only
 * submits a diff between a private copy and Shared Working, and editing Shared
 * directly is precisely what empties that diff.
 *
 * So the lock is now a real state: the only way into a locked workspace is a
 * private copy, a review submission, and a publisher applying it. Withdrawing
 * the lock reopens direct editing.
 */
export const isWorkspaceContentLocked = (workspace: Pick<WorkspaceRecord,
  'visibility' | 'workspaceType' | 'currentPublishedVersionId'>): boolean => (
  isSharedWorkspaceRecord(workspace) && Boolean(workspace.currentPublishedVersionId)
);

/**
 * Whether this member may withdraw the workspace's current lock.
 *
 * Kept apart from `canPublish` on purpose. `canPublish` also offers a new lock,
 * which needs a live audience, so it requires an active workspace. Withdrawing
 * does not. A lock outlives unsharing, and the owner is the only person left
 * who can lift it, so an unshared workspace still allows the withdraw. Without
 * this the owner had to re-share, withdraw, and unshare again, which let the
 * old audience back in for that time.
 */
export const resolveCanWithdrawLock = (input: {
  isShared: boolean;
  status?: WorkspaceRecord['status'];
  hasCurrentLock: boolean;
  roleCanPublish: boolean;
}): boolean => {
  const status = input.status || 'active';
  return input.isShared
    && (status === 'active' || status === 'unshared' || status === 'archived')
    && input.hasCurrentLock
    && input.roleCanPublish;
};

/**
 * The single definition of "may this member change workspace content".
 *
 * Three call sites answered this question independently — `ensureMembership`,
 * `listWorkspacesForUser` and `listCollaborators` — and they disagreed: the list
 * query ignored `editingPolicy` entirely, so a Review-mode contributor was told
 * they could edit and then refused on save. Deriving it once is what stops the
 * UI and the server from contradicting each other again (see `LEARNINGS.md` §12).
 *
 * The two results are deliberately distinct:
 * - `canEditRole` — would this role be allowed to edit, ignoring the lock.
 * - `canEdit` — may they edit *right now*.
 *
 * Callers that gate genuine content writes want `canEdit`. Callers that only
 * need "more than a viewer" — reading a schedule, listing knowledge sources —
 * want `canEditRole`, because a lock must not turn a read into an error.
 */
export const resolveWorkspaceContentEditAccess = (input: {
  isShared: boolean;
  status?: WorkspaceRecord['status'];
  role: WorkspaceRole;
  editingPolicy?: 'direct' | 'review' | null;
  contentLocked: boolean;
}): { canEditRole: boolean; canEdit: boolean } => {
  if (input.status === 'trashed' || input.status === 'purged') {
    return { canEditRole: false, canEdit: false };
  }
  const editingPolicy = input.editingPolicy || 'review';
  const canEditRole = !input.isShared
    || input.role === 'owner'
    || (editingPolicy === 'direct' && (input.role === 'editor' || input.role === 'contributor'));
  return { canEditRole, canEdit: canEditRole && !input.contentLocked };
};

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
  /** Vestigial; see `WorkspaceRecord.teamId`. Read `teamNames` instead. */
  teamId: string | null;
  teamNames: string[];
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
  /**
   * Assert the caller may change workspace *content* right now. Refused when the
   * role does not permit editing, and also when the Shared workspace holds a
   * current locked version.
   */
  requireEdit?: boolean;
  /**
   * Assert only that the caller's role would permit editing, ignoring the
   * content lock.
   *
   * For callers that were using `requireEdit` to mean "more than a viewer" on a
   * path that reads rather than writes — listing schedules, reading a knowledge
   * source. Locking a workspace must not turn those into errors. Kept as a
   * separate, narrower option rather than widening those routes to viewers,
   * which would be a product change smuggled in under a bug fix.
   */
  requireEditRole?: boolean;
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
    canWithdrawLock: boolean;
    teamName?: string | null;
    teams: Array<{ id: string; name: string; role: WorkspaceNamedGrantRole }>;
    canLeave: boolean;
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
      .leftJoin('workspace_publication_links as private_link', 'private_link.privateWorkspaceId', 'w.id')
      .leftJoin('workspaces as linked_team', 'linked_team.id', 'private_link.teamWorkspaceId')
      .leftJoin('workspace_members as linked_team_member', function joinLinkedTeamMembership() {
        this.on('linked_team_member.workspaceId', '=', 'private_link.teamWorkspaceId')
          .andOnVal('linked_team_member.userId', '=', userId);
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
        // Vestigial: passed through to keep the row shape, never used to decide
        // access or to derive `teams`.
        'w.teamId',
        'w.currentPublishedVersionId',
        'w.contentRevision',
        'w.createdAt',
        'w.updatedAt',
        'wm.role as directRole',
        'wm.canEdit as directCanEdit',
        this.db.raw(`(
          SELECT tg.role FROM workspace_team_grants AS tg
          JOIN group_members AS gm ON gm."groupId" = tg."teamId" AND gm."userId" = ?
          WHERE tg."workspaceId" = w.id
          ORDER BY ${TEAM_GRANT_RANK_SQL.replace(/"role"/g, 'tg.role')} DESC, tg."teamId" ASC
          LIMIT 1
        ) as "teamGrantRole"`, [userId]),
        this.db.raw(`(
          SELECT jsonb_agg(jsonb_build_object('id', team.id, 'name', team.name, 'role', tg.role)
                           ORDER BY team.name)
          FROM workspace_team_grants AS tg
          JOIN groups AS team ON team.id = tg."teamId"
          WHERE tg."workspaceId" = w.id
        ) as "teams"`),
        'private_link.teamWorkspaceId as linkedTeamWorkspaceId',
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
        this.db.raw(`(
          SELECT EXISTS (
            SELECT 1 FROM workspace_team_grants AS tg
            JOIN group_members AS gm ON gm."groupId" = tg."teamId" AND gm."userId" = ?
            WHERE tg."workspaceId" = private_link."teamWorkspaceId"
          )
        ) as "linkedTeamTeamAccess"`, [userId]),
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
                  .orWhereRaw(`EXISTS (
                    SELECT 1 FROM workspace_team_grants AS tg
                    JOIN group_members AS gm ON gm."groupId" = tg."teamId" AND gm."userId" = ?
                    WHERE tg."workspaceId" = w.id
                  )`, [userId]);
              });
          });
      })
      .andWhere('w.isSystem', false)
      // The Skill Builder's scratch workspace belongs to the user but is not theirs to
      // work in. Listing it would put a drafting area in the sidebar beside real work.
      .andWhere('w.isBuilderScratch', false)
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
      const teamRole: WorkspaceRole | null = row.teamGrantRole
        ? storedTeamGrantRole(row.teamGrantRole)
        : null;
      // `json_agg` yields null when a workspace has no grants.
      const teams: Array<{ id: string; name: string; role: WorkspaceNamedGrantRole }> =
        Array.isArray(row.teams) ? row.teams : [];
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
        && (Boolean(row.linkedTeamRole) || Boolean(row.linkedTeamTeamAccess));
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
        // Vestigial; `teams` is the answer. Kept only until the column drops.
        teamId: row.teamId,
        currentPublishedVersionId: row.currentPublishedVersionId,
        contentRevision: Number(row.contentRevision || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        role: effectiveRole,
        // Same resolver the access check uses. This expression used to ignore
        // `editingPolicy` altogether, so a Review-mode contributor was handed an
        // editable canvas and then refused on save; it would have ignored the
        // content lock the same way.
        canEdit: resolveWorkspaceContentEditAccess({
          isShared: visibility === 'team',
          status: row.status || 'active',
          role: effectiveRole,
          editingPolicy: visibility === 'team' ? (row.editingPolicy || 'review') : null,
          contentLocked: visibility === 'team' && Boolean(row.currentPublishedVersionId),
        }).canEdit,
        // Read from `effectiveRole`, not `directRole`. The server authorises
        // publishing through `ensureMembership`, which merges the team grant into
        // the role it returns, so deriving the button from the direct grant alone
        // would hide it from a team Publisher the endpoint would accept.
        canPublish: (row.status || 'active') === 'active'
          && visibility === 'team'
          && getWorkspaceRoleCapabilities(effectiveRole).canPublish,
        canWithdrawLock: resolveCanWithdrawLock({
          isShared: visibility === 'team',
          status: row.status || 'active',
          hasCurrentLock: Boolean(row.currentPublishedVersionId),
          roleCanPublish: getWorkspaceRoleCapabilities(effectiveRole).canPublish,
        }),
        teams,
        // Kept until every reader moves to `teams`. Derived from the same list
        // rather than a second join, so the two cannot disagree.
        teamName: teams[0]?.name ?? null,
        // Every input is already on the row, so this costs no extra query. It
        // replaces `audienceType`, which described the workspace when the
        // question is about the person reading it.
        canLeave: resolveWorkspaceLeaveVerdict({
          isShared: visibility === 'team',
          status: row.status || 'active',
          isOwner: row.ownerId === userId,
          hasDirectMembership: Boolean(row.directRole),
          reachesViaTeam: Boolean(row.teamGrantRole),
        }).canLeave,
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
,
    )
      .select(
        'w.id', 'w.name', 'w.slug', 'w.visibility', 'w.workspaceType', 'w.status',
        // 'w.teamId' is vestigial; the admin view reads `teamNames`.
        'w.editingPolicy', 'w.ownerId', 'w.teamId', 'w.contentRevision',
        'w.trashedAt', 'w.trashReason', 'w.purgeAfter', 'w.purgedAt',
        'w.createdAt', 'w.updatedAt',
        'owner.displayName as ownerName', 'owner.email as ownerEmail', 'owner.status as ownerStatus',
        // A subquery, not a join: this query has no DISTINCT and every other
        // join is by primary key, so a join here would double rows and corrupt
        // the paging.
        this.db.raw(`(
          SELECT array_agg(team.name ORDER BY team.name)
          FROM workspace_team_grants AS tg
          JOIN groups AS team ON team.id = tg."teamId"
          WHERE tg."workspaceId" = w.id
        ) as "teamNames"`),
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
        // Vestigial; `teamNames` is the answer.
        teamId: (row.teamId as string | null) ?? null,
        // `array_agg` yields null, not an empty array, when there are no grants.
        teamNames: Array.isArray(row.teamNames) ? row.teamNames as string[] : [],
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

  /**
   * The Skill Builder's own workspace for this user, created on first use.
   *
   * The builder used to invent a synthetic id, `skill-builder-<userId>`, and create only
   * a directory. Every part of the shared run path that reasonably assumes a workspaceId
   * identifies a `workspaces` row then failed on it: the uuid columns in run telemetry
   * and provenance rejected the string, and `ensureMembership` rejected the lookup,
   * which killed the run outright. A real row removes the whole class rather than
   * guarding each site as it is discovered.
   *
   * Dedicated, never one of the user's own workspaces: the builder writes and deletes
   * files here, and the run path mirrors the workspace's files before it starts, so
   * pointing it at real work would put that work in reach of a drafting session.
   */
  async ensureBuilderScratchWorkspace(user: UserContext): Promise<WorkspaceRecord> {
    const existing = await this.db<WorkspaceRecord>('workspaces')
      .where({ ownerId: user.userId, isBuilderScratch: true } as any)
      .first();
    if (existing) return existing;

    const workspaceId = uuidv4();
    const slug = await this.generateUniqueSlug(`skill-builder-${user.userId}`);
    let workspace: WorkspaceRecord | undefined;
    try {
      [workspace] = await this.db<WorkspaceRecord>('workspaces')
        .insert({
          id: workspaceId,
          name: 'Skill Builder drafts',
          slug,
          ownerId: user.userId,
          lastModifiedBy: user.userId,
          visibility: 'private',
          workspaceType: 'private',
          editingPolicy: null,
          contentRevision: 0,
          isBuilderScratch: true,
        } as any)
        .returning('*');
    } catch (error) {
      // Two builder sessions can open at once. Whoever lost the race reuses the row the
      // winner created rather than failing the request.
      const raced = await this.db<WorkspaceRecord>('workspaces')
        .where({ ownerId: user.userId, isBuilderScratch: true } as any)
        .first();
      if (!raced) throw error;
      return raced;
    }

    await this.db('workspace_members').insert({
      workspaceId,
      userId: user.userId,
      role: 'owner',
      canEdit: true,
    }).onConflict(['workspaceId', 'userId']).ignore();

    await this.createWorkspaceDirectory(workspaceId);
    return workspace as WorkspaceRecord;
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
    // Role check only, so a locked workspace can still be renamed. The published
    // manifest carries file names, hashes and object keys — never the workspace
    // name — so a rename provably cannot alter what was locked, and blocking it
    // would mean withdrawing the lock and burning a version number to fix a typo
    // in a title.
    const { workspace: currentWorkspace, membership } = await this.ensureMembership(
      workspaceId,
      userId,
      { requireEditRole: true },
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
    //
    // Returns through `finalizeMembership` rather than constructing its own
    // membership: this exit used to hard-code `canEdit: true`, which is how an
    // owner silently escaped every rule the other exit applied.
    if (normalizedWorkspace.ownerId === userId) {
      return this.finalizeMembership(normalizedWorkspace, {
        workspaceId,
        userId,
        role: 'owner',
        canEdit: true,
        createdAt: normalizedWorkspace.createdAt,
        updatedAt: normalizedWorkspace.updatedAt,
      }, options);
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
    // Any team the caller belongs to that holds a grant, strongest role first.
    // This used to ask whether the caller was in the single team named on the
    // workspace row, which meant a grant for any other team was inert — and it
    // disagreed with `skillGovernanceService.requireWorkspaceRead`, which has
    // always asked the question this way.
    //
    // Only for Shared workspaces. A private one cannot carry grants, and this is
    // the hottest authorization path in the service — no reason to spend a query
    // proving what the discriminator already says.
    const teamRole = isSharedWorkspaceRecord(normalizedWorkspace)
      ? await resolveTeamGrantRole(this.db, workspaceId, userId)
      : null;
    if (!teamRole && !membership && !adminOverride && isSharedWorkspaceRecord(normalizedWorkspace)) {
      throw new AccessDeniedError('Team membership is required to access this workspace');
    }
    if (teamRole) {
      const now = new Date().toISOString();
      membership = {
        workspaceId,
        userId,
        role: strongestWorkspaceRole(membership?.role, teamRole),
        // Placeholder; `finalizeMembership` derives the real value.
        canEdit: false,
        createdAt: membership?.createdAt || now,
        updatedAt: membership?.updatedAt || now,
      };
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

    // The admin override is read-only by construction, so it keeps its own
    // verdict rather than being re-derived from a role it does not really hold.
    return this.finalizeMembership(
      normalizedWorkspace,
      { ...membership, role: membership.role as WorkspaceRole },
      options,
      usingAdminOverride ? adminOverride!.canEdit : undefined,
    );
  }

  /**
   * The one exit every `ensureMembership` path returns through.
   *
   * Both exits used to decide `canEdit` for themselves, and the owner exit
   * decided `true` unconditionally — so any rule added to the general path
   * silently did not apply to owners. Everything that resolves an edit right now
   * happens here, once.
   */
  private finalizeMembership(
    workspace: WorkspaceRecord,
    membership: WorkspaceMembershipRecord,
    options: MembershipCheckOptions,
    overrideCanEdit?: boolean,
  ): { workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord } {
    const isShared = workspace.visibility === 'team';
    const editingPolicy = workspace.editingPolicy || 'review';
    const contentLocked = isWorkspaceContentLocked(workspace);
    const { canEditRole, canEdit } = resolveWorkspaceContentEditAccess({
      isShared,
      status: workspace.status,
      role: membership.role,
      editingPolicy,
      contentLocked,
    });

    const normalizedMembership: WorkspaceMembershipRecord = {
      ...membership,
      canEdit: overrideCanEdit !== undefined ? overrideCanEdit : canEdit,
    };
    const effectiveCanEditRole = overrideCanEdit !== undefined ? overrideCanEdit : canEditRole;

    // Role before lock, deliberately. A viewer in a locked workspace must be
    // told they are a viewer — pointing them at a private copy they may not
    // create would send them down a path that dead-ends.
    if ((options.requireEdit || options.requireEditRole) && !effectiveCanEditRole) {
      if (isShared && editingPolicy === 'review') {
        throw new AccessDeniedError('This Shared workspace uses Review mode. Submit changes for review.');
      }
      throw new AccessDeniedError('Workspace is read-only for this user');
    }
    if (options.requireEdit && !normalizedMembership.canEdit) {
      throw new WorkspaceContentLockedError(workspace.id);
    }

    return { workspace, membership: normalizedMembership };
  }

  /**
   * Whether this user may change workspace content right now, as a plain answer
   * rather than a thrown refusal.
   *
   * For callers that must decide whether to *attempt* a write at all — an agent
   * run deciding whether to commit its artifacts. The write itself stays behind
   * `requireEdit`, so a missed check still fails closed.
   */
  async canWriteWorkspaceContent(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const { membership } = await this.ensureMembership(workspaceId, userId);
      return membership.canEdit;
    } catch {
      return false;
    }
  }

  async getMcpServerPolicy(
    workspaceId: string,
    userId: string,
    options: MembershipCheckOptions = {},
  ): Promise<McpServerPolicy> {
    const { membership } = await this.ensureMembership(workspaceId, userId, options);
    const workspacePolicy = await this.db('workspaces')
      // `status` is selected so an unshared workspace cannot present itself as
      // live: Team Chat's agent gates on `workspaceMode`, and `shared_live`
      // would let it keep writing into a chat nobody else could reach.
      .select('skipPlanApprovals', 'visibility', 'editingPolicy', 'status')
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

    // Unsharing leaves `visibility` at 'team', so `visibility` alone does not
    // say whether an audience still exists. Only the owner reaches an unshared
    // workspace, so the agent treats it as private: the owner's agent may write
    // wherever the owner may write by hand. Folding the status into the write
    // flag alone would deny the agent while `membership.canEdit` lets the owner
    // edit the same file.
    const isActive = (workspacePolicy?.status || 'active') === 'active';
    const isLiveShared = workspacePolicy?.visibility === 'team' && isActive;

    return {
      mcpServerAllowIds: Array.from(new Set(allow)).sort(),
      mcpServerDenyIds: Array.from(new Set(deny)).sort(),
      isAdmin,
      skipPlanApprovals: Boolean(workspacePolicy?.skipPlanApprovals),
      workspaceMode: isLiveShared ? 'shared_live' : 'private',
      workspaceRole: membership.role,
      canWriteWorkspace: isLiveShared
        ? workspacePolicy.editingPolicy === 'direct' && membership.canEdit
        : membership.canEdit,
      editingPolicy: isLiveShared
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
      const directMembership = await tx('workspace_members').where({ workspaceId, userId }).first();
      // The same resolver the sidebar reads, so the button and this endpoint
      // cannot disagree about whether leaving is possible.
      const verdict = resolveWorkspaceLeaveVerdict({
        isShared: isSharedWorkspaceRecord(workspace),
        status: workspace.status,
        isOwner: workspace.ownerId === userId,
        hasDirectMembership: Boolean(directMembership),
        reachesViaTeam: Boolean(await resolveTeamGrantRole(tx, workspaceId, userId)),
      });
      if (!verdict.canLeave) throw workspaceLeaveRefusal(verdict.reason);
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

    await this.db.transaction(async (tx) => {
      await tx('workspace_members').where({ workspaceId, userId: targetUserId }).del();
      await tx('workspace_user_grants').where({ workspaceId, userId: targetUserId }).del();
      // Asked after the direct grant is gone, so it answers "can they still get
      // in by any route?" rather than "did they have a direct row?".
      await detachUnreachablePublicationLinks(tx, {
        teamWorkspaceIds: [workspaceId],
        userId: targetUserId,
      });
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
    role: WorkspaceNamedGrantRole = 'viewer',
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

    await this.db.transaction(async (tx) => {
      // No `workspaces.teamId` write: the grant is the record. That column could
      // hold one value, which is the whole reason a second team was refused.
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
    const existingGrant = await this.db('workspace_team_grants').where({ workspaceId, teamId }).first();
    if (!existingGrant) {
      throw new NotFoundError('Team access not found');
    }

    await this.db.transaction(async (tx) => {
      // Revoke first, then ask who can still reach the workspace. Sweeping
      // before the delete would force the sweep to know which team was going,
      // and the old one did not — it detached every draft whose owner held no
      // direct membership, which with several teams meant the other teams' too.
      await tx('workspace_team_grants').where({ workspaceId, teamId }).del();
      const detachedPrivateWorkspaceIds = await detachUnreachablePublicationLinks(tx, {
        teamWorkspaceIds: [workspaceId],
      });
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
    teams: Array<{ id: string; name: string; role: WorkspaceNamedGrantRole }>;
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
    const teams = await buildWorkspaceTeamAccessQuery(this.db, workspaceId) as Array<{
      id: string;
      name: string;
      role: WorkspaceNamedGrantRole;
    }>;
    if (teams.length) {
      // Each team carries its own role, so members are folded in per team rather
      // than under one role taken from the first grant. Someone in two granted
      // teams accumulates the strongest, which is also what `ensureMembership`
      // gives them.
      const groupMembers = await this.db('group_members')
        .join('users', 'group_members.userId', 'users.id')
        .select('group_members.userId', 'users.displayName', 'group_members.groupId')
        .whereIn('group_members.groupId', teams.map((team) => team.id))
        .orderBy('users.displayName', 'asc');
      const roleByTeamId = new Map(teams.map((team) => [
        team.id,
        storedTeamGrantRole(team.role),
      ]));
      groupMembers.forEach((row: any) => {
        const existing = effectiveCollaborators.get(row.userId);
        const role = strongestWorkspaceRole(existing?.role, roleByTeamId.get(String(row.groupId)));
        effectiveCollaborators.set(row.userId, {
          userId: row.userId,
          displayName: row.displayName,
          role,
          canEdit: resolveWorkspaceContentEditAccess({
            isShared: true,
            status: workspace.status,
            role,
            editingPolicy: workspace.editingPolicy,
            contentLocked: isWorkspaceContentLocked(workspace),
          }).canEdit,
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
        role: namedTeamGrantRole(row.role),
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
