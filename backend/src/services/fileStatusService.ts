import { randomUUID } from 'crypto';
import type { Knex } from 'knex';

import type {
  FileStatus,
  FileStatusState,
  FileStatusTransition,
  WorkspaceFileStatusSummary,
} from '@helpudoc/contracts/types';

import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { jsonbParam } from '../lib/jsonb';
import type { DatabaseService } from './databaseService';
import { isSharedWorkspaceRecord } from './workspaceService';
import type { WorkspaceService, WorkspaceRole, WorkspaceRecord } from './workspaceService';
import { getWorkspaceRoleCapabilities } from './workspaceCollaborationPolicy';
import { governanceLockKeys, withGovernanceLock } from './governance/governanceLocks';
import { nextAuditSeq, recordFileEvent } from './fileAuditService';
import type { FilePublicationService, PublishedArtifact } from './filePublicationService';
import type { FileService } from './fileService';

/**
 * Editorial lifecycle for a file: draft -> in_review -> approved -> published.
 *
 * Every transition is checked against the workspace role, serialized with an
 * advisory lock, and recorded twice: a rich event on the file's own trail, and
 * a governance row in `audit_events` so file decisions sit alongside skill and
 * workspace decisions in one compliance view.
 *
 * `published` is not reachable here. It is set by the per-file publication
 * step, which writes an immutable artifact — a status flag alone would claim
 * something was published when nothing was exported.
 */

export const FILE_STATUS_POLICY_VERSION = 'file-status-1';

type Capability = 'canPropose' | 'canApprove' | 'canPublish';

interface TransitionRule {
  from: FileStatus;
  to: FileStatus;
  capability: Capability;
  /** The file's author may also make this move, regardless of capability. */
  authorMayAct?: boolean;
  requiresReason?: boolean;
  isRevert?: boolean;
  label: string;
  action: string;
}

/**
 * The whole state machine. Anything not listed here is rejected, so adding a
 * path is a deliberate edit rather than an emergent behaviour.
 */
const TRANSITIONS: TransitionRule[] = [
  { from: 'draft', to: 'in_review', capability: 'canPropose', label: 'Submit for review', action: 'file.status.submitted' },
  { from: 'in_review', to: 'approved', capability: 'canApprove', label: 'Approve', action: 'file.status.approved' },
  {
    from: 'in_review', to: 'draft', capability: 'canApprove', authorMayAct: true,
    requiresReason: true, isRevert: true,
    label: 'Request changes', action: 'file.status.changes_requested',
  },
  {
    from: 'approved', to: 'in_review', capability: 'canApprove',
    requiresReason: true, isRevert: true,
    label: 'Send back to review', action: 'file.status.reverted',
  },
  {
    from: 'approved', to: 'draft', capability: 'canApprove',
    requiresReason: true, isRevert: true,
    label: 'Return to draft', action: 'file.status.reverted',
  },
  { from: 'approved', to: 'published', capability: 'canPublish', label: 'Publish', action: 'file.status.published' },
  {
    from: 'published', to: 'approved', capability: 'canPublish',
    requiresReason: true, isRevert: true,
    label: 'Unpublish', action: 'file.status.unpublished',
  },
  {
    from: 'published', to: 'in_review', capability: 'canPublish',
    requiresReason: true, isRevert: true,
    label: 'Unpublish and review', action: 'file.status.unpublished',
  },
  {
    from: 'published', to: 'draft', capability: 'canPublish',
    requiresReason: true, isRevert: true,
    label: 'Unpublish and return to draft', action: 'file.status.unpublished',
  },
];

const EVENT_TYPES: Record<string, string> = {
  'file.status.submitted': 'status.submitted',
  'file.status.approved': 'status.approved',
  'file.status.changes_requested': 'status.changes_requested',
  'file.status.reverted': 'status.reverted',
  'file.status.published': 'status.published',
  'file.status.unpublished': 'status.unpublished',
};

export const normalizeFileStatus = (value: unknown): FileStatus => {
  const candidate = String(value ?? 'draft');
  return (['draft', 'in_review', 'approved', 'published'] as const)
    .includes(candidate as FileStatus)
    ? candidate as FileStatus
    : 'draft';
};

/**
 * Approval attaches to a specific version. Once the content moves on, the
 * approval no longer describes what is there.
 */
export const hasDrifted = (file: {
  status?: unknown; version?: unknown;
  approvedAtVersion?: unknown; publishedAtVersion?: unknown;
}): boolean => {
  const status = normalizeFileStatus(file.status);
  const version = Number(file.version ?? 0);
  if (status === 'approved') {
    return file.approvedAtVersion != null && Number(file.approvedAtVersion) !== version;
  }
  if (status === 'published') {
    return file.publishedAtVersion != null && Number(file.publishedAtVersion) !== version;
  }
  return false;
};

export const allowedTransitionsFor = (
  status: FileStatus,
  role: WorkspaceRole,
  isAuthor: boolean,
  /**
   * False in a private workspace. Publishing exports an immutable artifact to
   * the shared release bucket, which is a team act: a private workspace stops
   * at `approved`. A `published` status can still arrive there by syncing from
   * the shared workspace, and is displayed read-only — moving out of it would
   * imply withdrawing an artifact this workspace does not own.
   */
  canPublishHere: boolean,
): FileStatusTransition[] => {
  const capabilities = getWorkspaceRoleCapabilities(role);
  return TRANSITIONS
    .filter((rule) => rule.from === status)
    .filter((rule) => canPublishHere || (rule.to !== 'published' && rule.from !== 'published'))
    .filter((rule) => capabilities[rule.capability] || (rule.authorMayAct && isAuthor))
    .map((rule) => ({
      toStatus: rule.to,
      requiresReason: Boolean(rule.requiresReason),
      isRevert: Boolean(rule.isRevert),
      label: rule.label,
    }));
};

/**
 * Approve the files a change proposal put under review, as part of accepting it.
 *
 * Accepting a proposal into the Shared workspace *is* the review decision, so
 * the files that were `in_review` move to `approved` in the same transaction as
 * the content. Anything else — a draft that rode along in the same proposal —
 * is left alone, because nobody submitted it for review.
 *
 * A standalone function rather than a method because `WorkspacePublicationService`
 * is constructed before `FileStatusService` (`api/routes.ts`), so it holds no
 * reference to it. `recordFileEvent` is standalone for the same reason.
 */
export async function approveFilesOnProposalAccepted(
  tx: Knex.Transaction,
  input: {
    workspaceId: string;
    fileIds: number[];
    userId: string;
    role: WorkspaceRole;
  },
): Promise<number[]> {
  if (!input.fileIds.length) return [];

  // Same lock the manual path takes, but joined to this transaction: a reviewer
  // clicking Approve must not interleave with an accept on the same file.
  for (const fileId of input.fileIds) {
    const [classId, objectId] = governanceLockKeys('file_status', String(fileId));
    await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [classId, objectId]);
  }

  const candidates = await tx('files')
    .whereIn('id', input.fileIds)
    .where({ workspaceId: input.workspaceId, status: 'in_review' })
    .whereNull('deletedAt');

  const approved: number[] = [];
  for (const file of candidates) {
    const fileId = Number(file.id);
    const version = Number(file.version ?? 0);
    const auditEventId = randomUUID();

    const audit = await recordFileEvent(tx, {
      fileId,
      workspaceId: input.workspaceId,
      filePath: String(file.name),
      eventType: 'status.approved',
      seq: nextAuditSeq(file),
      prevEventHash: file.lastAuditHash ?? null,
      actorUserId: input.userId,
      actorType: 'human',
      fileVersion: version,
      fileVersionId: file.currentVersionId ?? null,
      sha256: null,
      payload: {
        fromStatus: 'in_review',
        toStatus: 'approved',
        actorRole: input.role,
        reason: null,
        isRevert: false,
        // Not self-approval: the accepter is signing off someone else's
        // proposal. Applying the content makes them `updatedBy`, so the usual
        // guard would otherwise block every accept. Recorded rather than
        // implied, so the exemption is visible in the trail.
        selfApproved: false,
        viaProposalAccept: true,
        auditEventId,
      },
    });

    await tx('files').where({ id: fileId }).update({
      status: 'approved',
      approvedAtVersion: version,
      statusUpdatedAt: tx.fn.now(),
      statusUpdatedBy: input.userId,
      updatedAt: tx.fn.now(),
      ...(audit ? { auditSeq: audit.seq, lastAuditHash: audit.eventHash } : {}),
    });

    await tx('audit_events').insert({
      id: auditEventId,
      actorUserId: input.userId,
      actorRole: input.role,
      action: 'file.status.approved',
      resourceType: 'file',
      resourceId: String(fileId),
      reason: null,
      policyVersion: FILE_STATUS_POLICY_VERSION,
      selfApproved: false,
      metadata: jsonbParam(tx, {
        workspaceId: input.workspaceId,
        filePath: String(file.name),
        fromStatus: 'in_review',
        toStatus: 'approved',
        fileVersion: version,
        fileVersionId: file.currentVersionId ?? null,
        viaProposalAccept: true,
      }),
    });
    approved.push(fileId);
  }
  return approved;
}

export class FileStatusService {
  private readonly db: Knex;

  constructor(
    databaseService: DatabaseService,
    private readonly workspaceService: WorkspaceService,
    /** Absent on servers with no publication target configured. */
    private readonly publicationService?: FilePublicationService,
    /** Used to assemble the provenance frozen beside a published artifact. */
    private readonly fileService?: FileService,
  ) {
    this.db = databaseService.getDb();
  }

  private async loadFile(fileId: number) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    return file;
  }

  private toState(file: any, role: WorkspaceRole, userId: string, canPublishHere: boolean): FileStatusState {
    const status = normalizeFileStatus(file.status);
    return {
      fileId: Number(file.id),
      workspaceId: String(file.workspaceId),
      status,
      version: Number(file.version ?? 0),
      statusUpdatedAt: file.statusUpdatedAt ?? null,
      statusUpdatedBy: file.statusUpdatedBy ?? null,
      approvedAtVersion: file.approvedAtVersion ?? null,
      publishedAtVersion: file.publishedAtVersion ?? null,
      drift: hasDrifted(file),
      allowedTransitions: allowedTransitionsFor(
        status, role, String(file.createdBy) === userId, canPublishHere,
      ),
    };
  }

  /**
   * The provenance document published alongside an artifact.
   *
   * Carries the full record — prompts, responses, retrieved knowledge — rather
   * than references, because the artifact has to answer "why does this document
   * say this?" without depending on any other system surviving. That makes it
   * permanently unredactable, which is a deliberate compliance trade.
   */
  private async buildPublishedProvenance(
    fileId: number,
    userId: string,
    snapshot: { publishedBy: string; publishedAtVersion: number },
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.fileService) return undefined;
    try {
      const document = await this.fileService.getFileProvenance(fileId, userId);
      return {
        ...document,
        snapshot: {
          takenAt: new Date().toISOString(),
          takenBy: snapshot.publishedBy,
          fileVersion: snapshot.publishedAtVersion,
          chainHead: document.integrity.chainHead,
          eventCount: document.integrity.eventCount,
        },
      };
    } catch (error) {
      // A publish must not fail because the history could not be assembled;
      // the artifact is still the thing being released.
      console.error('Failed to build published provenance', {
        fileId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return undefined;
    }
  }

  async getStatus(fileId: number, userId: string): Promise<FileStatusState> {
    const file = await this.loadFile(fileId);
    const { workspace, membership } = await this.workspaceService.ensureMembership(
      file.workspaceId, userId,
    );
    return this.toState(file, membership.role, userId, this.canPublishFrom(workspace));
  }

  /**
   * Whether this workspace may publish at all; see `allowedTransitionsFor`.
   *
   * Deliberately only about visibility, not about whether the server has a
   * publication target configured. Conflating the two would also block
   * *unpublishing* on a server with no target, and withdrawing a publication
   * does not need one.
   */
  private canPublishFrom(workspace: WorkspaceRecord): boolean {
    return isSharedWorkspaceRecord(workspace);
  }

  async transition(
    fileId: number,
    userId: string,
    input: { toStatus: FileStatus; reason?: string; expectedVersion?: number },
  ): Promise<FileStatusState> {
    const file = await this.loadFile(fileId);
    const { workspace, membership } = await this.workspaceService.ensureMembership(
      file.workspaceId, userId, { requireEdit: true },
    );
    const role = membership.role as WorkspaceRole;

    // Visibility is checked before server configuration: a private workspace
    // cannot publish however the server is set up, and saying so is more use
    // than "not configured". Checked before the artifact write, and
    // `transition` is the only caller of `publishArtifact`, so this is the
    // complete gate.
    const canPublishHere = this.canPublishFrom(workspace);
    if (!canPublishHere && (input.toStatus === 'published' || normalizeFileStatus(file.status) === 'published')) {
      throw new ConflictError(
        'Only a Shared workspace can publish a file. Approve it here, then publish from the Shared workspace.',
      );
    }
    if (input.toStatus === 'published' && !this.publicationService) {
      throw new ConflictError('Publishing is not configured on this server');
    }

    // Serialize per file so two reviewers cannot both decide from the same
    // starting state.
    return withGovernanceLock(this.db, 'file_status', String(fileId), async () => {
      const locked = await this.loadFile(fileId);
      const from = normalizeFileStatus(locked.status);
      const version = Number(locked.version ?? 0);

      if (from === input.toStatus) {
        throw new ConflictError(`File is already ${from}`);
      }
      const rule = TRANSITIONS.find((entry) => entry.from === from && entry.to === input.toStatus);
      if (!rule) {
        throw new ConflictError(`Cannot move a file from ${from} to ${input.toStatus}`);
      }

      const isAuthor = String(locked.createdBy) === userId;
      const capabilities = getWorkspaceRoleCapabilities(role);
      if (!capabilities[rule.capability] && !(rule.authorMayAct && isAuthor)) {
        throw new AccessDeniedError(`Your role cannot ${rule.label.toLowerCase()}`);
      }

      // Whoever last changed the content should not also sign it off.
      const selfApproval = rule.to === 'approved' && String(locked.updatedBy ?? locked.createdBy) === userId;
      if (selfApproval && role !== 'owner') {
        throw new AccessDeniedError('You cannot approve a file you last edited');
      }

      const reason = input.reason?.trim() || '';
      if (rule.requiresReason && !reason) {
        throw new ConflictError(`A reason is required to ${rule.label.toLowerCase()}`);
      }
      if (typeof input.expectedVersion === 'number' && input.expectedVersion !== version) {
        throw new ConflictError(
          `File changed since you loaded it (expected v${input.expectedVersion}, now v${version})`,
        );
      }

      // Objects before the row. An unreferenced artifact is recoverable — a
      // published status pointing at nothing is not.
      let publication: PublishedArtifact | undefined;
      if (rule.to === 'published') {
        // Frozen beside the artifact so the pair is readable on its own, even
        // if this database is later gone.
        const provenance = await this.buildPublishedProvenance(fileId, userId, {
          publishedBy: userId,
          publishedAtVersion: version,
        });
        publication = await this.publicationService!.publishArtifact(fileId, userId, { provenance });
      }

      const now = new Date();
      const patch: Record<string, unknown> = {
        status: rule.to,
        statusUpdatedAt: now,
        statusUpdatedBy: userId,
        updatedAt: now,
      };
      // Pin the version the decision applies to, and clear it when the file
      // leaves that state so stale drift is not reported later.
      if (rule.to === 'approved') patch.approvedAtVersion = version;
      if (from === 'approved' && rule.to !== 'published') patch.approvedAtVersion = null;
      if (from === 'published') patch.publishedAtVersion = null;
      if (publication) {
        patch.publishedAtVersion = version;
        patch.currentPublicationId = publication.id;
        patch.publicationVersion = publication.publicationVersion;
      }

      const auditEventId = randomUUID();
      let updated: any;
      await this.db.transaction(async (tx) => {
        const audit = await recordFileEvent(tx, {
          fileId: Number(locked.id),
          workspaceId: String(locked.workspaceId),
          filePath: String(locked.name),
          eventType: (EVENT_TYPES[rule.action] || 'status.reverted') as any,
          seq: nextAuditSeq(locked),
          prevEventHash: locked.lastAuditHash ?? null,
          actorUserId: userId,
          actorType: 'human',
          fileVersion: version,
          fileVersionId: locked.currentVersionId ?? null,
          sha256: null,
          payload: {
            fromStatus: from,
            toStatus: rule.to,
            actorRole: role,
            reason: reason || null,
            isRevert: Boolean(rule.isRevert),
            selfApproved: selfApproval,
            auditEventId,
            ...(publication ? {
              publicationVersion: publication.publicationVersion,
              publishedName: publication.publishedName,
              targetUri: publication.targetUri,
              artifactSha256: publication.sha256,
            } : {}),
          },
        });
        if (audit) {
          patch.auditSeq = audit.seq;
          patch.lastAuditHash = audit.eventHash;
        }

        if (from === 'published' && locked.currentPublicationId) {
          // The artifact stays; only the record of it being current changes.
          await tx('file_publications')
            .where({ id: locked.currentPublicationId })
            .whereNull('withdrawnAt')
            .update({ withdrawnAt: now, withdrawnByUserId: userId });
          patch.currentPublicationId = null;
        }

        [updated] = await tx('files').where({ id: fileId }).update(patch).returning('*');

        // Governance mirror, so file decisions appear beside skill and
        // workspace decisions in one query.
        await tx('audit_events').insert({
          id: auditEventId,
          actorUserId: userId,
          actorRole: role,
          action: rule.action,
          resourceType: 'file',
          resourceId: String(fileId),
          reason: reason || null,
          policyVersion: FILE_STATUS_POLICY_VERSION,
          selfApproved: selfApproval,
          metadata: jsonbParam(this.db, {
            workspaceId: String(locked.workspaceId),
            filePath: String(locked.name),
            fromStatus: from,
            toStatus: rule.to,
            fileVersion: version,
            fileVersionId: locked.currentVersionId ?? null,
          }),
        });
      });

      return this.toState(updated, role, userId, canPublishHere);
    });
  }

  /** Per-status counts plus what is currently waiting on a reviewer. */
  async getWorkspaceSummary(workspaceId: string, userId: string): Promise<WorkspaceFileStatusSummary> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const rows = await this.db('files')
      .select('id', 'name', 'version', 'status', 'statusUpdatedAt', 'approvedAtVersion', 'publishedAtVersion')
      .where({ workspaceId })
      .whereNull('deletedAt');

    const counts: Record<FileStatus, number> = {
      draft: 0, in_review: 0, approved: 0, published: 0,
    };
    const reviewQueue: WorkspaceFileStatusSummary['reviewQueue'] = [];
    for (const row of rows) {
      const status = normalizeFileStatus(row.status);
      counts[status] += 1;
      if (status === 'in_review') {
        reviewQueue.push({
          fileId: Number(row.id),
          name: String(row.name),
          version: Number(row.version ?? 0),
          status,
          statusUpdatedAt: row.statusUpdatedAt ?? null,
          drift: hasDrifted(row),
        });
      }
    }
    reviewQueue.sort((left, right) => String(left.statusUpdatedAt ?? '').localeCompare(String(right.statusUpdatedAt ?? '')));
    return { counts, reviewQueue };
  }
}
