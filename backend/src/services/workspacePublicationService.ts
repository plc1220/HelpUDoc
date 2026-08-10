import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import { DatabaseService } from './databaseService';
import type { ObjectStore } from './objectStore';
import { getObjectStore } from './objectStoreFactory';
import { WorkspaceRecord, WorkspaceRole, WorkspaceService } from './workspaceService';
import { getWorkspaceRoleCapabilities } from './workspaceCollaborationPolicy';

import {
  namedGrantToLegacyWorkspaceRole,
  normalizeSelectedWorkspaceUsers,
  type WorkspaceNamedGrantRole,
} from './workspaceAudiencePolicy';
import {
  countChangedLines,
  findPublicationConflicts,
  hasFileChanged,
  mergePublicationFolders,
  type PublicationConflict,
} from './workspacePublicationDiff';

const WORKSPACE_DIR = resolveWorkspaceRoot();
const VERSION_ROOT = path.join(WORKSPACE_DIR, '.published-versions');
const INTERNAL_WORKSPACE_DIR_NAMES = new Set(['.system', 'sandbox-runs']);

type PublishResolution = 'private' | 'team';

type ContentFile = {
  name: string;
  mimeType: string | null;
  buffer: Buffer;
  hash: string;
  size: number;
  fileVersionId?: string | null;
  objectKey?: string | null;
  objectProvider?: string | null;
  providerVersion?: string | null;
};

type PublicationManifestFile = {
  name: string;
  mimeType: string | null;
  hash: string;
  size: number;
  fileVersionId?: string | null;
  objectKey?: string | null;
  objectProvider?: string | null;
  providerVersion?: string | null;
};

type PublicationManifest = {
  files: PublicationManifestFile[];
  folders: string[];
};

type PublishedVersionRecord = {
  id: string;
  teamWorkspaceId: string;
  versionNumber: number;
  sourcePrivateWorkspaceId?: string | null;
  sourceContentRevision: number;
  publisherUserId: string | null;
  note?: string | null;
  manifest: PublicationManifest | PublicationManifestFile[];
  createdAt: string;
};

type PublicationLinkRecord = {
  privateWorkspaceId: string;
  teamWorkspaceId: string;
  userId: string;
  basePublishedVersionId: string | null;
  basePrivateContentRevision: number;
  baseSharedContentRevision: number;
  baseWorkingManifest?: PublicationManifest | PublicationManifestFile[] | string | null;
  hasUnpublishedChanges: boolean;
  status?: 'active' | 'detached';
  detachedAt?: string | null;
  reconnectToken?: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceContent = {
  files: Map<string, ContentFile>;
  folders: string[];
};

export class WorkspacePublicationService {
  private readonly db: Knex;
  private readonly workspaceService: WorkspaceService;
  private readonly objectStore: ObjectStore;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.objectStore = getObjectStore();
  }

  async publish(
    workspaceId: string,
    userId: string,
    input: {
      audience?: 'team' | 'selected_people';
      teamId?: string;
      userIds?: string[];
      role?: WorkspaceNamedGrantRole;
      note?: string;
      name?: string;
    },
  ) {
    const { workspace, membership } = await this.workspaceService.ensureMembership(workspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Share this workspace before creating a published version');
    }
    this.ensurePublisher(membership.role);
    return this.createLivePublishedVersion(workspace, userId, input.note);
  }

  async withdraw(workspaceId: string, userId: string) {
    const { workspace, membership } = await this.workspaceService.ensureMembership(workspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Only Shared workspace publications can be withdrawn');
    }
    this.ensurePublisher(membership.role);

    return this.db.transaction(async (tx) => {
      const locked = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspaceId })
        .forUpdate()
        .first();
      if (!locked || locked.visibility !== 'team') {
        throw new ConflictError('Only Shared workspace publications can be withdrawn');
      }

      const publisherMembership = await tx('workspace_members')
        .select('role')
        .where({ workspaceId, userId })
        .forShare()
        .first() as { role?: WorkspaceRole } | undefined;
      this.ensurePublisher(publisherMembership?.role || 'viewer');

      if (!locked.currentPublishedVersionId) {
        throw new ConflictError('This workspace does not have a current published version');
      }
      const withdrawnVersion = await tx<PublishedVersionRecord>('workspace_published_versions')
        .where({ id: locked.currentPublishedVersionId, teamWorkspaceId: workspaceId })
        .first();
      if (!withdrawnVersion) {
        throw new NotFoundError('Current published version not found');
      }

      await tx('workspaces').where({ id: workspaceId }).update({
        currentPublishedVersionId: null,
        updatedAt: tx.fn.now(),
        lastModifiedBy: userId,
      });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: userId,
        actorRole: 'workspace_owner_or_publisher',
        action: 'workspace.publication_withdrawn',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: {
          withdrawnVersionId: withdrawnVersion.id,
          withdrawnVersionNumber: Number(withdrawnVersion.versionNumber),
        },
      });

      return {
        workspaceId,
        withdrawnVersionId: withdrawnVersion.id,
        withdrawnVersionNumber: Number(withdrawnVersion.versionNumber),
      };
    });
  }

  async shareWithAudience(
    privateWorkspaceId: string,
    userId: string,
    input: {
      userIds?: string[];
      teamId?: string;
      role?: WorkspaceNamedGrantRole;
      name?: string;
      editingPolicy?: 'direct' | 'review';
    },
  ) {
    const { workspace, membership } = await this.workspaceService.ensureMembership(
      privateWorkspaceId,
      userId,
    );
    if (membership.role !== 'owner' || workspace.ownerId !== userId) {
      throw new AccessDeniedError('Only the owner can share this workspace');
    }
    if (workspace.visibility !== 'private') {
      throw new ConflictError('This workspace is already shared; manage access instead');
    }

    const selectedUserIds = normalizeSelectedWorkspaceUsers(userId, input.userIds);
    if (!selectedUserIds.length && !input.teamId) {
      throw new ConflictError('Choose at least one team or person before sharing');
    }
    if (selectedUserIds.length) {
      await this.ensureRegisteredUsers(selectedUserIds);
    }
    if (input.teamId) {
      const team = await this.db('groups').where({ id: input.teamId }).first();
      if (!team) {
        throw new NotFoundError('Team not found');
      }
      const teamMembership = await this.db('group_members')
        .where({ groupId: input.teamId, userId })
        .first();
      if (!teamMembership) {
        throw new AccessDeniedError('You must belong to the team before sharing with it');
      }
    }
    const selectedRole = input.role || 'viewer';
    const legacyRole = namedGrantToLegacyWorkspaceRole(selectedRole);
    const teamRole = selectedRole === 'viewer' ? 'viewer' : 'contributor';
    const editingPolicy = input.editingPolicy || workspace.editingPolicy || 'direct';

    await this.db.transaction(async (tx) => {
      const locked = await tx<WorkspaceRecord>('workspaces')
        .where({ id: workspace.id })
        .forUpdate()
        .first();
      if (!locked || locked.ownerId !== userId) {
        throw new AccessDeniedError('Only the owner can share this workspace');
      }

      await tx('workspaces').where({ id: workspace.id }).update({
        visibility: 'team',
        workspaceType: 'team',
        teamId: input.teamId || null,
        editingPolicy,
        updatedAt: tx.fn.now(),
      });
      await tx('workspace_members')
        .insert({ workspaceId: workspace.id, userId, role: 'owner', canEdit: true })
        .onConflict(['workspaceId', 'userId'])
        .merge({ role: 'owner', canEdit: true, updatedAt: tx.fn.now() });
      if (selectedUserIds.length) {
        await tx('workspace_members')
          .insert(selectedUserIds.map((selectedUserId) => ({
            workspaceId: workspace.id,
            userId: selectedUserId,
            role: legacyRole,
            canEdit: editingPolicy === 'direct' && selectedRole !== 'viewer',
          })))
          .onConflict(['workspaceId', 'userId'])
          .merge({
            role: legacyRole,
            canEdit: editingPolicy === 'direct' && selectedRole !== 'viewer',
            updatedAt: tx.fn.now(),
          });
      }
      if (selectedUserIds.length) {
        await tx('workspace_user_grants')
          .insert(selectedUserIds.map((selectedUserId) => ({
            workspaceId: workspace.id,
            userId: selectedUserId,
            role: selectedRole,
            grantedByUserId: userId,
          })))
          .onConflict(['workspaceId', 'userId'])
          .merge({ role: selectedRole, grantedByUserId: userId, updatedAt: tx.fn.now() });
      }
      if (input.teamId) {
        await tx('workspace_team_grants')
          .insert({
            workspaceId: workspace.id,
            teamId: input.teamId,
            role: teamRole,
            grantedByUserId: userId,
          })
          .onConflict(['workspaceId', 'teamId'])
          .merge({ role: teamRole, grantedByUserId: userId, updatedAt: tx.fn.now() });
      }
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: userId,
        actorRole: 'workspace_owner',
        action: locked.visibility === 'private' ? 'workspace.shared' : 'workspace.access_granted',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { selectedUserIds, selectedRole, editingPolicy, teamId: input.teamId || null },
      });
    });

    const privateCopy = editingPolicy === 'review'
      ? await this.createPrivateCopy(workspace.id, userId)
      : null;

    return {
      workspaceId: workspace.id,
      privateWorkspaceId: privateCopy?.id || null,
      privateCopyWorkspaceId: privateCopy?.id || null,
      teamWorkspaceId: workspace.id,
      sharedWithUserIds: selectedUserIds,
      sharedWithTeamId: input.teamId || null,
      editingPolicy,
    };
  }

  async createPrivateCopy(teamWorkspaceId: string, userId: string) {
    const { workspace: teamWorkspace, membership } = await this.workspaceService.ensureMembership(
      teamWorkspaceId,
      userId,
    );
    if (teamWorkspace.visibility !== 'team') {
      throw new ConflictError('A private copy can only be created from a Shared workspace');
    }
    if (!getWorkspaceRoleCapabilities(membership.role).canPropose) {
      throw new AccessDeniedError('Contributor access is required to create a private working copy');
    }

    const existing = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ teamWorkspaceId, userId })
      .first();
    if (existing) {
      let workspace = await this.db<WorkspaceRecord>('workspaces')
        .where({ id: existing.privateWorkspaceId })
        .first();
      if (workspace) {
        if (existing.status === 'detached') {
          await this.reconnect(existing.privateWorkspaceId, userId);
        } else if (this.isActiveWorkspace(workspace) && this.isActiveSharedWorkspace(teamWorkspace)) {
          await this.syncFromSharedWorking(
            existing.privateWorkspaceId,
            workspace,
            teamWorkspace,
            existing,
            userId,
            {},
          );
        }
        workspace = await this.db<WorkspaceRecord>('workspaces')
          .where({ id: existing.privateWorkspaceId })
          .first() as WorkspaceRecord;
        return this.toPrivateWorkspaceResponse(workspace, teamWorkspaceId);
      }
    }

    const currentVersion = teamWorkspace.currentPublishedVersionId
      ? await this.getPublishedVersion(teamWorkspace.currentPublishedVersionId, teamWorkspace.id)
      : null;
    const content = await this.readWorkspaceContent(teamWorkspace.id);
    const privateWorkspaceId = uuidv4();
    const name = await this.resolveUniquePrivateCopyName(userId, teamWorkspace.name);
    const slug = await this.generateUniqueSlug(name);

    await this.db.transaction(async (tx) => {
      await tx('workspaces').insert({
        id: privateWorkspaceId,
        name,
        slug,
        ownerId: userId,
        lastModifiedBy: userId,
        visibility: 'private',
        workspaceType: 'private',
        editingPolicy: null,
        contentRevision: 0,
      });
      await tx('workspace_members').insert({
        workspaceId: privateWorkspaceId,
        userId,
        role: 'owner',
        canEdit: true,
      });
      if (currentVersion) {
        await this.copyPublishedSkillPinsToWorkspace(
          tx,
          currentVersion.id,
          privateWorkspaceId,
          userId,
        );
      } else {
        await this.copyValidatedWorkspaceSkillPins(tx, teamWorkspace.id, privateWorkspaceId);
      }
    });

    try {
      const contentRevision = await this.replaceWorkspaceContent(privateWorkspaceId, content, userId);
      await this.db('workspace_publication_links').insert({
        privateWorkspaceId,
        teamWorkspaceId,
        userId,
        basePublishedVersionId: currentVersion?.id || null,
        basePrivateContentRevision: contentRevision,
        baseSharedContentRevision: Number(teamWorkspace.contentRevision || 0),
        baseWorkingManifest: this.manifestFromContent(content),
        hasUnpublishedChanges: false,
        status: 'active',
        detachedAt: null,
      });
    } catch (error) {
      await this.db('workspaces').where({ id: privateWorkspaceId }).del();
      await fs.rm(path.join(WORKSPACE_DIR, privateWorkspaceId), { recursive: true, force: true });
      throw error;
    }

    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: privateWorkspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Private working copy was not created');
    }
    return this.toPrivateWorkspaceResponse(workspace, teamWorkspaceId);
  }

  async getPrivateCopyReviewChanges(privateWorkspaceId: string, userId: string) {
    const privateWorkspace = await this.db<WorkspaceRecord>('workspaces')
      .where({ id: privateWorkspaceId, visibility: 'private' })
      .first();
    if (!privateWorkspace) throw new NotFoundError('Private working copy not found');
    const link = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ privateWorkspaceId })
      .first();
    if (!link) {
      throw new ConflictError('This private workspace is not linked to a Shared workspace');
    }
    const { workspace: sharedWorkspace, membership: sharedMembership } = await this.workspaceService.ensureMembership(
      link.teamWorkspaceId,
      userId,
    );
    const ownsPrivateCopy = privateWorkspace.ownerId === userId;
    if (!ownsPrivateCopy) {
      if (sharedMembership.role !== 'owner' && sharedMembership.role !== 'editor') {
        throw new AccessDeniedError('Owner or Publisher access is required to review proposed changes');
      }
      const linkedProposal = await this.db('workspace_collaboration_objects')
        .where({
          workspaceId: link.teamWorkspaceId,
          linkedPrivateWorkspaceId: privateWorkspaceId,
          type: 'change_proposal',
        })
        .whereIn('status', ['proposed', 'discussing'])
        .first();
      if (!linkedProposal) {
        throw new AccessDeniedError('This private copy does not have an open Review proposal');
      }
    }
    const [privateContent, sharedContent, proposal] = await Promise.all([
      this.readWorkspaceContent(privateWorkspaceId),
      this.readWorkspaceContent(link.teamWorkspaceId),
      this.db('workspace_collaboration_objects')
        .select('id', 'status', 'title', 'updatedAt')
        .where({
          workspaceId: link.teamWorkspaceId,
          linkedPrivateWorkspaceId: privateWorkspaceId,
          type: 'change_proposal',
        })
        .whereIn('status', ['proposed', 'discussing'])
        .orderBy('updatedAt', 'desc')
        .first(),
    ]);

    const filePaths = [...new Set([
      ...privateContent.files.keys(),
      ...sharedContent.files.keys(),
    ])].sort((left, right) => left.localeCompare(right));
    const files = filePaths.flatMap((filePath) => {
      const privateFile = privateContent.files.get(filePath);
      const sharedFile = sharedContent.files.get(filePath);
      if (privateFile?.hash === sharedFile?.hash) return [];
      const status = !sharedFile ? 'added' : !privateFile ? 'deleted' : 'modified';
      const canCompareText = (!privateFile || this.isTextContent(privateFile))
        && (!sharedFile || this.isTextContent(sharedFile));
      const privateText = canCompareText ? privateFile?.buffer.toString('utf-8') || '' : undefined;
      const sharedText = canCompareText ? sharedFile?.buffer.toString('utf-8') || '' : undefined;
      const textLimit = 100_000;
      const lineChanges = canCompareText
        ? countChangedLines(sharedText!, privateText!)
        : { added: status === 'added' ? 1 : 0, removed: status === 'deleted' ? 1 : 0, exact: false };
      return [{
        path: filePath,
        status,
        mimeType: privateFile?.mimeType || sharedFile?.mimeType || null,
        privateSize: privateFile?.size || 0,
        sharedSize: sharedFile?.size || 0,
        addedLines: lineChanges.added,
        removedLines: lineChanges.removed,
        lineCountsExact: lineChanges.exact,
        canCompareText,
        ...(canCompareText ? {
          privateText: privateText!.slice(0, textLimit),
          sharedText: sharedText!.slice(0, textLimit),
          textTruncated: privateText!.length > textLimit || sharedText!.length > textLimit,
        } : {}),
      }];
    });

    const privateFolders = new Set(privateContent.folders);
    const sharedFolders = new Set(sharedContent.folders);
    const folderChanges = [
      ...privateContent.folders
        .filter((folder) => !sharedFolders.has(folder))
        .map((path) => ({ path, status: 'added' as const })),
      ...sharedContent.folders
        .filter((folder) => !privateFolders.has(folder))
        .map((path) => ({ path, status: 'deleted' as const })),
    ].sort((left, right) => left.path.localeCompare(right.path));

    return {
      privateWorkspaceId,
      sharedWorkspaceId: link.teamWorkspaceId,
      privateWorkspaceName: privateWorkspace.name,
      sharedWorkspaceName: sharedWorkspace.name,
      baseSharedContentRevision: Number(link.baseSharedContentRevision || 0),
      currentSharedContentRevision: Number(sharedWorkspace.contentRevision || 0),
      privateContentRevision: Number(privateWorkspace.contentRevision || 0),
      isStale: Number(link.baseSharedContentRevision || 0) !== Number(sharedWorkspace.contentRevision || 0),
      hasChanges: files.length > 0 || folderChanges.length > 0,
      files,
      folderChanges,
      proposal: proposal || null,
    };
  }

  async applyPrivateCopyToShared(
    privateWorkspaceId: string,
    sharedWorkspaceId: string,
    userId: string,
  ) {
    const { workspace: sharedWorkspace, membership } = await this.workspaceService.ensureMembership(
      sharedWorkspaceId,
      userId,
    );
    if (sharedWorkspace.visibility !== 'team') {
      throw new ConflictError('Change proposals can only be applied to Shared workspaces');
    }
    this.ensurePublisher(membership.role);

    const link = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ privateWorkspaceId, teamWorkspaceId: sharedWorkspaceId })
      .first();
    if (!link) {
      throw new ConflictError('The proposal is not linked to this Shared workspace');
    }
    const privateWorkspace = await this.db<WorkspaceRecord>('workspaces')
      .where({ id: privateWorkspaceId })
      .first();
    if (!privateWorkspace || privateWorkspace.visibility !== 'private') {
      throw new NotFoundError('Proposal working copy not found');
    }
    const sourceRevision = Number(privateWorkspace.contentRevision || 0);
    const content = await this.readWorkspaceContent(privateWorkspaceId);

    return this.db.transaction(async (tx) => {
      const lockedShared = await tx<WorkspaceRecord>('workspaces')
        .where({ id: sharedWorkspaceId })
        .forUpdate()
        .first();
      const lockedPrivate = await tx<WorkspaceRecord>('workspaces')
        .where({ id: privateWorkspaceId })
        .forShare()
        .first();
      if (!lockedShared || !lockedPrivate) {
        throw new NotFoundError('Proposal workspace not found');
      }
      if (Number(lockedPrivate.contentRevision || 0) !== sourceRevision) {
        throw new ConflictError('The proposal changed while it was being applied. Try again.');
      }
      if (Number(lockedShared.contentRevision || 0) !== Number(link.baseSharedContentRevision || 0)) {
        throw new ConflictError('The Shared workspace changed after this proposal was created', {
          code: 'PROPOSAL_STALE',
          baseRevision: Number(link.baseSharedContentRevision || 0),
          currentRevision: Number(lockedShared.contentRevision || 0),
        });
      }

      const appliedRevision = await this.replaceWorkspaceContent(
        sharedWorkspaceId,
        content,
        userId,
        tx,
      );
      await tx('workspace_publication_links')
        .where({ privateWorkspaceId, teamWorkspaceId: sharedWorkspaceId })
        .update({
          basePrivateContentRevision: sourceRevision,
          baseSharedContentRevision: appliedRevision,
          baseWorkingManifest: this.manifestFromContent(content),
          hasUnpublishedChanges: false,
          status: 'active',
          detachedAt: null,
          updatedAt: tx.fn.now(),
        });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: userId,
        actorRole: 'workspace_owner_or_publisher',
        action: 'workspace.proposal_applied',
        resourceType: 'workspace',
        resourceId: sharedWorkspaceId,
        metadata: { privateWorkspaceId, sourceRevision, appliedRevision },
      });
      return { workspaceId: sharedWorkspaceId, contentRevision: appliedRevision };
    });
  }

  async sync(
    privateWorkspaceId: string,
    userId: string,
    resolutions: Record<string, PublishResolution> = {},
  ) {
    const { workspace: privateWorkspace } = await this.workspaceService.ensureMembership(
      privateWorkspaceId,
      userId,
      { requireEdit: true },
    );
    if (privateWorkspace.visibility !== 'private' || privateWorkspace.ownerId !== userId) {
      throw new AccessDeniedError('Only the owner can sync a private workspace');
    }

    const link = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ privateWorkspaceId, userId })
      .first();
    if (!link) {
      throw new ConflictError('This private workspace is not linked to a Shared workspace');
    }
    if (link.status === 'active' && link.reconnectToken) {
      throw new ConflictError('This private workspace is already reconnecting');
    }

    if (link.status === 'detached') {
      return this.detachedSyncResult(privateWorkspaceId, link.teamWorkspaceId);
    }
    if (!this.isActiveWorkspace(privateWorkspace)) {
      return this.detachPublicationLink(link);
    }

    const sharedWorkspace = await this.db<WorkspaceRecord>('workspaces')
      .where({ id: link.teamWorkspaceId })
      .first();
    if (!this.isActiveSharedWorkspace(sharedWorkspace)) {
      return this.detachPublicationLink(link);
    }

    let teamWorkspace: WorkspaceRecord;
    try {
      ({ workspace: teamWorkspace } = await this.workspaceService.ensureMembership(link.teamWorkspaceId, userId));
    } catch (error) {
      if (error instanceof AccessDeniedError || error instanceof NotFoundError) {
        return this.detachPublicationLink(link);
      }
      throw error;
    }

    if (link.baseWorkingManifest) {
      return this.syncFromSharedWorking(privateWorkspaceId, privateWorkspace, teamWorkspace, link, userId, resolutions);
    }

    // Legacy links may not have an exact Working base. A clean private copy can
    // safely initialize one by fast-forwarding; a dirty copy must not guess
    // that a release snapshot was its Working ancestor.
    const privateIsClean = Number(privateWorkspace.contentRevision || 0)
      === Number(link.basePrivateContentRevision || 0)
      && !link.hasUnpublishedChanges;
    if (privateIsClean) {
      return this.syncFromSharedWorking(privateWorkspaceId, privateWorkspace, teamWorkspace, link, userId, resolutions);
    }
    return this.reviewNeededSyncResult(privateWorkspaceId, teamWorkspace.id, [], {
      reason: 'BASE_WORKING_MANIFEST_UNAVAILABLE',
    });
  }

  async reconnect(privateWorkspaceId: string, userId: string) {
    const { workspace: privateWorkspace } = await this.workspaceService.ensureMembership(
      privateWorkspaceId,
      userId,
      { requireEdit: true },
    );
    if (
      privateWorkspace.visibility !== 'private'
      || privateWorkspace.ownerId !== userId
      || !this.isActiveWorkspace(privateWorkspace)
    ) {
      throw new AccessDeniedError('Only an active private workspace owner can reconnect');
    }
    const link = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ privateWorkspaceId, userId })
      .first();
    if (!link) {
      throw new ConflictError('This private workspace is not linked to a Shared workspace');
    }
    if (link.status === 'active' && link.reconnectToken) {
      throw new ConflictError('This private workspace is already reconnecting');
    }
    const sharedWorkspace = await this.db<WorkspaceRecord>('workspaces')
      .where({ id: link.teamWorkspaceId })
      .first();
    if (!this.isActiveSharedWorkspace(sharedWorkspace)) {
      return this.detachPublicationLink(link);
    }
    try {
      await this.workspaceService.ensureMembership(link.teamWorkspaceId, userId);
    } catch (error) {
      if (error instanceof AccessDeniedError || error instanceof NotFoundError) {
        return this.detachPublicationLink(link);
      }
      throw error;
    }
    const reconnectToken = uuidv4();
    const activated = link.status === 'detached'
      ? await this.db('workspace_publication_links')
        .where({ privateWorkspaceId, userId, status: 'detached' })
        .update({
          status: 'active',
          detachedAt: null,
          reconnectToken,
          updatedAt: this.db.fn.now(),
        })
      : 0;
    if (link.status === 'detached' && activated !== 1) {
      throw new ConflictError('The private workspace link changed while reconnecting');
    }
    try {
      const result = await this.syncFromSharedWorking(
        privateWorkspaceId,
        privateWorkspace,
        sharedWorkspace!,
        {
          ...link,
          status: 'active',
          detachedAt: null,
          reconnectToken: activated === 1 ? reconnectToken : link.reconnectToken,
        },
        userId,
        {},
      );
      if (activated === 1) {
        await this.db('workspace_publication_links')
          .where({ privateWorkspaceId, userId, reconnectToken })
          .update({ reconnectToken: null, updatedAt: this.db.fn.now() });
      }
      return result;
    } catch (error) {
      // A failed comparison must not leave a previously detached draft looking
      // connected. The conditional update cannot undo a concurrent unshare,
      // which will already have moved the link back to detached itself.
      if (activated === 1) {
        await this.db('workspace_publication_links')
          .where({ privateWorkspaceId, userId, status: 'active', reconnectToken })
          .update({
            status: 'detached',
            detachedAt: this.db.fn.now(),
            reconnectToken: null,
            updatedAt: this.db.fn.now(),
          });
      }
      throw error;
    }
  }

  private async syncFromSharedWorking(
    privateWorkspaceId: string,
    privateWorkspace: WorkspaceRecord,
    teamWorkspace: WorkspaceRecord,
    link: PublicationLinkRecord,
    userId: string,
    resolutions: Record<string, PublishResolution>,
  ) {
    const currentSharedRevision = Number(teamWorkspace.contentRevision || 0);
    const [privateContent, sharedContent] = await Promise.all([
      this.readWorkspaceContent(privateWorkspaceId),
      this.readWorkspaceContent(teamWorkspace.id),
    ]);
    const baseContent = link.baseWorkingManifest
      ? this.workspaceContentFromManifest(link.baseWorkingManifest)
      : null;
    const privateChanged = baseContent
      ? !this.workspaceContentsMatch(baseContent, privateContent)
      : Number(privateWorkspace.contentRevision || 0) !== Number(link.basePrivateContentRevision || 0)
        || link.hasUnpublishedChanges;

    if (!baseContent) {
      if (privateChanged) {
        return this.reviewNeededSyncResult(privateWorkspaceId, teamWorkspace.id, [], {
          reason: 'BASE_WORKING_MANIFEST_UNAVAILABLE',
        });
      }
      return this.fastForwardSharedWorking(
        privateWorkspaceId,
        teamWorkspace,
        link,
        sharedContent,
        userId,
      );
    }

    const sharedChanged = !this.workspaceContentsMatch(baseContent, sharedContent);
    if (!sharedChanged) {
      return {
        workspaceId: privateWorkspaceId,
        teamWorkspaceId: teamWorkspace.id,
        status: 'up_to_date' as const,
        conflicts: [],
      };
    }
    if (!privateChanged) {
      return this.fastForwardSharedWorking(
        privateWorkspaceId,
        teamWorkspace,
        link,
        sharedContent,
        userId,
      );
    }

    const conflicts = findPublicationConflicts(
      this.toHashMap(baseContent),
      this.toHashMap(privateContent),
      this.toHashMap(sharedContent),
    );
    const unresolved = conflicts.filter((conflict) => !resolutions[conflict.path]);
    if (unresolved.length) {
      return this.reviewNeededSyncResult(
        privateWorkspaceId,
        teamWorkspace.id,
        this.presentConflicts(unresolved, privateContent, sharedContent),
      );
    }

    const merged = this.mergeWorkspaceContent(baseContent, privateContent, sharedContent, resolutions);
    await this.ensureContentObjects(teamWorkspace.id, sharedContent);
    const baseWorkingManifest = this.manifestFromContent(sharedContent);
    await this.replaceWorkspaceContent(
      privateWorkspaceId,
      merged,
      userId,
      undefined,
      async (tx, contentRevision) => {
        await this.assertSharedWorkingRevision(tx, teamWorkspace.id, currentSharedRevision);
        const updated = await tx('workspace_publication_links')
          .where({
            privateWorkspaceId,
            userId,
            status: 'active',
            baseSharedContentRevision: Number(link.baseSharedContentRevision || 0),
          })
          .update({
            basePublishedVersionId: teamWorkspace.currentPublishedVersionId || null,
            basePrivateContentRevision: contentRevision,
            baseSharedContentRevision: currentSharedRevision,
            baseWorkingManifest,
            hasUnpublishedChanges: !this.workspaceContentsMatch(merged, sharedContent),
            detachedAt: null,
            reconnectToken: null,
            updatedAt: tx.fn.now(),
          });
        if (updated !== 1) {
          throw new ConflictError('The private workspace link changed while syncing');
        }
      },
    );

    return {
      workspaceId: privateWorkspaceId,
      teamWorkspaceId: teamWorkspace.id,
      status: conflicts.length ? 'reviewed' as const : 'synced' as const,
      conflicts,
    };
  }

  private async fastForwardSharedWorking(
    privateWorkspaceId: string,
    teamWorkspace: WorkspaceRecord,
    link: PublicationLinkRecord,
    sharedContent: WorkspaceContent,
    userId: string,
  ) {
    const currentSharedRevision = Number(teamWorkspace.contentRevision || 0);
    await this.ensureContentObjects(teamWorkspace.id, sharedContent);
    const baseWorkingManifest = this.manifestFromContent(sharedContent);
    await this.replaceWorkspaceContent(
      privateWorkspaceId,
      sharedContent,
      userId,
      undefined,
      async (tx, contentRevision) => {
        await this.assertSharedWorkingRevision(tx, teamWorkspace.id, currentSharedRevision);
        const updated = await tx('workspace_publication_links')
          .where({
            privateWorkspaceId,
            userId,
            status: 'active',
            baseSharedContentRevision: Number(link.baseSharedContentRevision || 0),
          })
          .update({
            basePublishedVersionId: teamWorkspace.currentPublishedVersionId || null,
            basePrivateContentRevision: contentRevision,
            baseSharedContentRevision: currentSharedRevision,
            baseWorkingManifest,
            hasUnpublishedChanges: false,
            detachedAt: null,
            reconnectToken: null,
            updatedAt: tx.fn.now(),
          });
        if (updated !== 1) {
          throw new ConflictError('The private workspace link changed while syncing');
        }
        if (teamWorkspace.currentPublishedVersionId) {
          await this.copyPublishedSkillPinsToWorkspace(
            tx,
            teamWorkspace.currentPublishedVersionId,
            privateWorkspaceId,
            userId,
          );
        }
      },
    );
    return {
      workspaceId: privateWorkspaceId,
      teamWorkspaceId: teamWorkspace.id,
      status: 'synced' as const,
      conflicts: [],
    };
  }

  private async assertSharedWorkingRevision(
    tx: Knex.Transaction,
    teamWorkspaceId: string,
    expectedRevision: number,
  ): Promise<void> {
    const current = await tx<WorkspaceRecord>('workspaces')
      .select('contentRevision', 'visibility', 'status')
      .where({ id: teamWorkspaceId })
      .forShare()
      .first();
    if (
      !this.isActiveSharedWorkspace(current)
      || Number(current!.contentRevision || 0) !== expectedRevision
    ) {
      throw new ConflictError('Shared Working changed while syncing. Try again.', {
        code: 'SHARED_WORKING_CHANGED',
      });
    }
  }

  private isActiveSharedWorkspace(
    workspace: Pick<WorkspaceRecord, 'visibility' | 'status'> | null | undefined,
  ): workspace is Pick<WorkspaceRecord, 'visibility' | 'status'> {
    return Boolean(
      workspace
      && workspace.visibility === 'team'
      && this.isActiveWorkspace(workspace),
    );
  }

  private isActiveWorkspace(
    workspace: Pick<WorkspaceRecord, 'status'> | null | undefined,
  ): boolean {
    return Boolean(workspace && (workspace.status == null || workspace.status === 'active'));
  }

  private detachedSyncResult(privateWorkspaceId: string, teamWorkspaceId: string) {
    return {
      workspaceId: privateWorkspaceId,
      teamWorkspaceId,
      status: 'detached' as const,
      conflicts: [],
    };
  }

  private async detachPublicationLink(link: PublicationLinkRecord) {
    if (link.status !== 'detached') {
      await this.db('workspace_publication_links')
        .where({ privateWorkspaceId: link.privateWorkspaceId, userId: link.userId })
        .update({
          status: 'detached',
          detachedAt: this.db.fn.now(),
          reconnectToken: null,
          updatedAt: this.db.fn.now(),
        });
    }
    return this.detachedSyncResult(link.privateWorkspaceId, link.teamWorkspaceId);
  }

  private reviewNeededSyncResult(
    privateWorkspaceId: string,
    teamWorkspaceId: string,
    conflicts: unknown[],
    details: Record<string, unknown> = {},
  ) {
    return {
      workspaceId: privateWorkspaceId,
      teamWorkspaceId,
      status: 'review_needed' as const,
      conflicts,
      ...details,
    };
  }

  async listHistory(teamWorkspaceId: string, userId: string) {
    const { workspace } = await this.workspaceService.ensureMembership(teamWorkspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Publication history is only available for Shared workspaces');
    }
    return this.db('workspace_published_versions as version')
      .join('workspaces as workspace', 'workspace.id', 'version.teamWorkspaceId')
      .leftJoin('users as publisher', 'publisher.id', 'version.publisherUserId')
      .where('version.teamWorkspaceId', teamWorkspaceId)
      .select(
        'version.id',
        'version.versionNumber',
        'version.note',
        'version.createdAt',
        this.db.raw('(version.id = workspace."currentPublishedVersionId") as "isCurrent"'),
        this.db.raw(`COALESCE(publisher."displayName", 'Former user') as "publisherName"`),
      )
      .orderBy('version.versionNumber', 'desc');
  }

  /**
   * Describe a single published version plus the immutable file/folder listing captured in
   * its manifest. Read-only: it never touches the mutable Working version.
   */
  async getVersionSnapshot(teamWorkspaceId: string, versionId: string, userId: string) {
    const { workspace } = await this.workspaceService.ensureMembership(teamWorkspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Published versions are only available for Shared workspaces');
    }
    const version = await this.getPublishedVersion(versionId, teamWorkspaceId);
    const manifest = this.normalizeManifest(version.manifest);
    const files = manifest.files
      .map((file) => {
        const name = this.normalizeRelativePath(file.name);
        return {
          id: `published:${version.id}:${name}`,
          name,
          path: name,
          workspaceId: teamWorkspaceId,
          storageType: 'local' as const,
          mimeType: file.mimeType || null,
          size: Number(file.size || 0),
          fileVersionId: file.fileVersionId || null,
          sha256: file.hash,
          publishedVersionId: version.id,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      workspaceId: teamWorkspaceId,
      versionId: version.id,
      versionNumber: Number(version.versionNumber),
      note: version.note ?? null,
      createdAt: version.createdAt,
      isCurrent: workspace.currentPublishedVersionId === version.id,
      folders: [...new Set(manifest.folders.map((folder) => this.normalizeRelativePath(folder)))].sort(),
      files,
    };
  }

  /**
   * Read one file out of an immutable published snapshot. Mirrors the shape returned by
   * FileService.getFileContent so the workspace canvas can render it unchanged.
   */
  async readVersionFile(
    teamWorkspaceId: string,
    versionId: string,
    relativePath: string,
    userId: string,
  ) {
    const { workspace } = await this.workspaceService.ensureMembership(teamWorkspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Published versions are only available for Shared workspaces');
    }
    const version = await this.getPublishedVersion(versionId, teamWorkspaceId);
    const manifest = this.normalizeManifest(version.manifest);
    const safeName = this.normalizeRelativePath(relativePath);
    const entry = manifest.files.find((file) => this.normalizeRelativePath(file.name) === safeName);
    if (!entry) {
      throw new NotFoundError('File not found in this published version');
    }
    if (entry.objectKey) this.assertObjectProvider(entry.objectProvider);
    const buffer = entry.objectKey
      ? await this.readObjectBuffer(entry.objectKey, entry.providerVersion || undefined)
      : await fs.readFile(path.join(this.versionDirectory(version.id), safeName));
    const contentFile: ContentFile = {
      name: safeName,
      mimeType: entry.mimeType || null,
      buffer,
      hash: entry.hash,
      size: Number(entry.size || buffer.length),
      fileVersionId: entry.fileVersionId || null,
      objectKey: entry.objectKey || null,
      objectProvider: entry.objectProvider || null,
      providerVersion: entry.providerVersion || null,
    };
    return {
      id: `published:${version.id}:${safeName}`,
      name: safeName,
      path: safeName,
      workspaceId: teamWorkspaceId,
      storageType: 'local' as const,
      mimeType: contentFile.mimeType,
      size: contentFile.size,
      publishedVersionId: version.id,
      content: this.isTextContent(contentFile)
        ? buffer.toString('utf-8')
        : buffer.toString('base64'),
    };
  }

  async restore(teamWorkspaceId: string, versionId: string, userId: string) {
    const { workspace: teamWorkspace, membership } = await this.workspaceService.ensureMembership(
      teamWorkspaceId,
      userId,
    );
    if (teamWorkspace.visibility !== 'team' || membership.role !== 'owner') {
      throw new AccessDeniedError('Only the Shared workspace owner can restore a published version');
    }
    const restoredVersion = await this.getPublishedVersion(versionId, teamWorkspaceId);
    const content = await this.readPublishedVersionContent(restoredVersion);
    const newVersionId = uuidv4();
    const manifest = await this.writeVersionSnapshot(newVersionId, content);

    try {
      return await this.db.transaction(async (tx) => {
        const lockedTeam = await tx<WorkspaceRecord>('workspaces')
          .where({ id: teamWorkspaceId })
          .forUpdate()
          .first();
        if (!lockedTeam) {
          throw new NotFoundError('Shared workspace not found');
        }
        const currentOwnerMembership = await tx('workspace_members')
          .select('role')
          .where({ workspaceId: lockedTeam.id, userId })
          .forShare()
          .first() as { role?: WorkspaceRole } | undefined;
        if (currentOwnerMembership?.role !== 'owner') {
          throw new AccessDeniedError('Only the Shared workspace owner can restore a published version');
        }
        const previousVersion = lockedTeam.currentPublishedVersionId
          ? await tx<PublishedVersionRecord>('workspace_published_versions')
            .where({ id: lockedTeam.currentPublishedVersionId, teamWorkspaceId })
            .first()
          : null;
        const previousContent = previousVersion
          ? await this.readPublishedVersionContent(previousVersion)
          : await this.readWorkspaceContent(teamWorkspaceId);

        try {
          const nextVersionNumber = await this.getNextVersionNumber(teamWorkspaceId, tx);
          const restoredContentRevision = await this.replaceWorkspaceContent(teamWorkspaceId, content, userId, tx);
          const [created] = await tx<PublishedVersionRecord>('workspace_published_versions')
            .insert({
              id: newVersionId,
              teamWorkspaceId,
              versionNumber: nextVersionNumber,
              sourcePrivateWorkspaceId: null,
              sourceContentRevision: restoredContentRevision,
              publisherUserId: userId,
              note: `Restored version ${restoredVersion.versionNumber}`,
              manifest,
            })
            .returning('*');
          await this.restorePublishedSkillPins(tx, restoredVersion.id, teamWorkspaceId, created.id);
          await tx('workspaces')
            .where({ id: teamWorkspaceId })
            .update({
              currentPublishedVersionId: created.id,
              updatedAt: tx.fn.now(),
              lastModifiedBy: userId,
            });
          return created;
        } catch (error) {
          await this.replaceWorkspaceContent(teamWorkspaceId, previousContent, userId, tx)
            .catch((rollbackError) => {
              console.error('Failed to restore the previous team content after a restore error', rollbackError);
            });
          throw error;
        }
      });
    } catch (error) {
      await fs.rm(this.versionDirectory(newVersionId), { recursive: true, force: true });
      throw error;
    }
  }

  private async createLivePublishedVersion(
    workspace: WorkspaceRecord,
    userId: string,
    note?: string,
  ) {
    const sourceRevision = Number(workspace.contentRevision || 0);
    const content = await this.readWorkspaceContent(workspace.id);
    const versionId = uuidv4();
    const manifest = await this.writeVersionSnapshot(versionId, content);

    try {
      return await this.db.transaction(async (tx) => {
        const locked = await tx<WorkspaceRecord>('workspaces')
          .where({ id: workspace.id })
          .forUpdate()
          .first();
        if (!locked || locked.visibility !== 'team') {
          throw new ConflictError('Only Shared workspaces can be published');
        }
        if (Number(locked.contentRevision || 0) !== sourceRevision) {
          throw new ConflictError('The workspace changed while it was being published. Try again.', {
            code: 'WORKSPACE_REVISION_CHANGED',
          });
        }

        const publisherMembership = await tx('workspace_members')
          .select('role')
          .where({ workspaceId: locked.id, userId })
          .forShare()
          .first() as { role?: WorkspaceRole } | undefined;
        this.ensurePublisher(publisherMembership?.role || 'viewer');

        if (locked.currentPublishedVersionId) {
          const current = await tx<PublishedVersionRecord>('workspace_published_versions')
            .where({ id: locked.currentPublishedVersionId, teamWorkspaceId: locked.id })
            .first();
          if (current && Number(current.sourceContentRevision || 0) === sourceRevision) {
            throw new ConflictError('There are no workspace changes to publish');
          }
        }

        const versionNumber = await this.getNextVersionNumber(locked.id, tx);
        const [version] = await tx<PublishedVersionRecord>('workspace_published_versions')
          .insert({
            id: versionId,
            teamWorkspaceId: locked.id,
            versionNumber,
            sourcePrivateWorkspaceId: null,
            sourceContentRevision: sourceRevision,
            publisherUserId: userId,
            note: String(note || '').trim() || null,
            manifest,
          })
          .returning('*');
        await this.freezeWorkspaceSkillPins(tx, locked.id, locked.id, version.id);
        await tx('workspaces').where({ id: locked.id }).update({
          currentPublishedVersionId: version.id,
          updatedAt: tx.fn.now(),
          lastModifiedBy: userId,
        });
        await tx('audit_events').insert({
          id: uuidv4(),
          actorUserId: userId,
          actorRole: 'workspace_owner_or_publisher',
          action: 'workspace.version_published',
          resourceType: 'workspace',
          resourceId: locked.id,
          metadata: {
            publishedVersionId: version.id,
            versionNumber: Number(version.versionNumber),
            sourceContentRevision: sourceRevision,
          },
        });

        return {
          workspaceId: locked.id,
          teamWorkspaceId: locked.id,
          privateWorkspaceId: locked.id,
          publishedVersionId: version.id,
          publishedVersionNumber: Number(version.versionNumber),
          publishedAt: version.createdAt,
        };
      });
    } catch (error) {
      await fs.rm(this.versionDirectory(versionId), { recursive: true, force: true });
      throw error;
    }
  }

  private async publishFirstVersion(
    privateWorkspace: WorkspaceRecord,
    userId: string,
    input: {
      teamId?: string;
      selectedUserIds?: string[];
      selectedRole?: WorkspaceNamedGrantRole;
      note?: string;
      name?: string;
    },
  ) {
    const teamWorkspace = await this.createTeamWorkspace(privateWorkspace, userId, input);

    try {
      return await this.createPublishedVersion({
        privateWorkspace,
        teamWorkspace,
        userId,
        note: input.note,
        existingLink: null,
      });
    } catch (error) {
      await this.db('workspaces').where({ id: teamWorkspace.id }).del();
      await fs.rm(path.join(WORKSPACE_DIR, teamWorkspace.id), { recursive: true, force: true });
      throw error;
    }
  }

  private async createTeamWorkspace(
    privateWorkspace: WorkspaceRecord,
    userId: string,
    input: {
      teamId?: string;
      selectedUserIds?: string[];
      selectedRole?: WorkspaceNamedGrantRole;
      name?: string;
    },
  ): Promise<WorkspaceRecord> {
    const teamWorkspaceId = uuidv4();
    const resolvedName = String(input.name || privateWorkspace.name).trim().slice(0, 255) || privateWorkspace.name;
    const slug = await this.generateUniqueSlug(resolvedName);
    const selectedUserIds = normalizeSelectedWorkspaceUsers(userId, input.selectedUserIds);
    const selectedRole = input.selectedRole || 'viewer';
    const legacyRole = namedGrantToLegacyWorkspaceRole(selectedRole);
    const teamRole = selectedRole === 'viewer' ? 'viewer' : 'contributor';

    await this.db.transaction(async (tx) => {
      await tx('workspaces').insert({
        id: teamWorkspaceId,
        name: resolvedName,
        slug,
        ownerId: userId,
        lastModifiedBy: userId,
        visibility: 'team',
        workspaceType: 'team',
        editingPolicy: 'review',
        teamId: input.teamId || null,
        contentRevision: 0,
      });
      await tx('workspace_members').insert({
        workspaceId: teamWorkspaceId,
        userId,
        role: 'owner',
        canEdit: false,
      });
      if (selectedUserIds.length) {
        await tx('workspace_members').insert(selectedUserIds.map((selectedUserId) => ({
          workspaceId: teamWorkspaceId,
          userId: selectedUserId,
          role: legacyRole,
          canEdit: false,
        })));
        await tx('workspace_user_grants').insert(selectedUserIds.map((selectedUserId) => ({
          workspaceId: teamWorkspaceId,
          userId: selectedUserId,
          role: selectedRole,
          grantedByUserId: userId,
        })));
      }
      if (input.teamId) {
        await tx('workspace_team_grants').insert({
          workspaceId: teamWorkspaceId,
          teamId: input.teamId,
          role: teamRole,
          grantedByUserId: userId,
        });
      }
    });

    const teamWorkspace = await this.db<WorkspaceRecord>('workspaces').where({ id: teamWorkspaceId }).first();
    if (!teamWorkspace) {
      throw new NotFoundError('Shared workspace was not created');
    }
    return teamWorkspace;
  }

  private async ensureRegisteredUsers(userIds: string[]): Promise<void> {
    const rows = await this.db('users').select('id').whereIn('id', userIds);
    if (rows.length !== userIds.length) {
      throw new NotFoundError('One or more selected users were not found');
    }
  }

  private async createPublishedVersion(input: {
    privateWorkspace: WorkspaceRecord;
    teamWorkspace: WorkspaceRecord;
    userId: string;
    note?: string;
    existingLink: PublicationLinkRecord | null;
  }) {
    const content = await this.readWorkspaceContent(input.privateWorkspace.id);
    const versionId = uuidv4();
    const manifest = await this.writeVersionSnapshot(versionId, content);

    try {
      return await this.db.transaction(async (tx) => {
        const lockedTeam = await tx<WorkspaceRecord>('workspaces')
          .where({ id: input.teamWorkspace.id })
          .forUpdate()
          .first();
        if (!lockedTeam) {
          throw new NotFoundError('Shared workspace not found');
        }

        const currentLink = input.existingLink
          ? await tx<PublicationLinkRecord>('workspace_publication_links')
            .where({ privateWorkspaceId: input.privateWorkspace.id })
            .forUpdate()
            .first()
          : null;
        const currentPrivate = await tx<WorkspaceRecord>('workspaces')
          .select('contentRevision')
          .where({ id: input.privateWorkspace.id })
          .forUpdate()
          .first();
        if (
          input.existingLink
          && (
            !currentLink
            || currentLink.teamWorkspaceId !== lockedTeam.id
            || currentLink.basePublishedVersionId !== input.existingLink.basePublishedVersionId
            || currentLink.basePublishedVersionId !== lockedTeam.currentPublishedVersionId
          )
        ) {
          throw new ConflictError('Team updates must be reviewed before publishing', {
            code: 'TEAM_UPDATES_AVAILABLE',
            teamWorkspaceId: lockedTeam.id,
          });
        }
        if (
          currentLink
          && lockedTeam.currentPublishedVersionId
          && !currentLink.hasUnpublishedChanges
          && Number(currentPrivate?.contentRevision || 0) === Number(currentLink.basePrivateContentRevision || 0)
        ) {
          throw new ConflictError('There are no private changes to publish');
        }

        const publisherMembership = await tx('workspace_members')
          .select('role')
          .where({ workspaceId: lockedTeam.id, userId: input.userId })
          .forShare()
          .first() as { role?: WorkspaceRole } | undefined;
        if (input.existingLink) {
          this.ensurePublisher(publisherMembership?.role || 'viewer');
        }

        const previousTeamContent = input.existingLink
          ? lockedTeam.currentPublishedVersionId
            ? await this.readPublishedVersionContent(
              await this.getPublishedVersion(lockedTeam.currentPublishedVersionId, lockedTeam.id),
            )
            : await this.readWorkspaceContent(lockedTeam.id)
          : null;

        try {
          const versionNumber = await this.getNextVersionNumber(lockedTeam.id, tx);
          const appliedSharedRevision = await this.replaceWorkspaceContent(
            lockedTeam.id,
            content,
            input.userId,
            tx,
          );
          const [version] = await tx<PublishedVersionRecord>('workspace_published_versions')
            .insert({
              id: versionId,
              teamWorkspaceId: lockedTeam.id,
              versionNumber,
              sourcePrivateWorkspaceId: input.privateWorkspace.id,
              sourceContentRevision: Number(currentPrivate?.contentRevision || 0),
              publisherUserId: input.userId,
              note: String(input.note || '').trim() || null,
              manifest,
            })
            .returning('*');
          if (!input.existingLink) {
            await tx('audit_events').insert({
              id: uuidv4(),
              actorUserId: input.userId,
              actorRole: 'workspace_owner',
              action: 'workspace.promoted',
              resourceType: 'workspace',
              resourceId: lockedTeam.id,
              metadata: {
                sourcePrivateWorkspaceId: input.privateWorkspace.id,
                audience: lockedTeam.teamId ? 'team' : 'selected_people',
                teamId: lockedTeam.teamId || null,
                editingPolicy: lockedTeam.editingPolicy || 'review',
              },
            });
          }
          await tx('audit_events').insert({
            id: uuidv4(),
            actorUserId: input.userId,
            actorRole: 'workspace_owner_or_publisher',
            action: 'workspace.version_published',
            resourceType: 'workspace',
            resourceId: lockedTeam.id,
            metadata: {
              publishedVersionId: version.id,
              versionNumber: Number(version.versionNumber),
              sourcePrivateWorkspaceId: input.privateWorkspace.id,
            },
          });
          await this.freezeWorkspaceSkillPins(
            tx,
            input.privateWorkspace.id,
            lockedTeam.id,
            version.id,
          );

          await tx('workspaces')
            .where({ id: lockedTeam.id })
            .update({
              currentPublishedVersionId: version.id,
              updatedAt: tx.fn.now(),
              lastModifiedBy: input.userId,
            });
          const linkPayload = {
            teamWorkspaceId: lockedTeam.id,
            userId: input.userId,
            basePublishedVersionId: version.id,
            basePrivateContentRevision: Number(currentPrivate?.contentRevision || 0),
            baseSharedContentRevision: appliedSharedRevision,
            baseWorkingManifest: manifest,
            hasUnpublishedChanges: false,
            status: 'active',
            detachedAt: null,
            updatedAt: tx.fn.now(),
          };
          if (input.existingLink) {
            await tx('workspace_publication_links')
              .where({ privateWorkspaceId: input.privateWorkspace.id })
              .update(linkPayload);
          } else {
            await tx('workspace_publication_links').insert({
              privateWorkspaceId: input.privateWorkspace.id,
              ...linkPayload,
            });
          }

          return {
            teamWorkspaceId: lockedTeam.id,
            privateWorkspaceId: input.privateWorkspace.id,
            publishedVersionId: version.id,
            publishedVersionNumber: Number(version.versionNumber),
            publishedAt: version.createdAt,
          };
        } catch (error) {
          if (previousTeamContent) {
            await this.replaceWorkspaceContent(lockedTeam.id, previousTeamContent, input.userId, tx)
              .catch((rollbackError) => {
                console.error('Failed to restore the previous team content after a publish error', rollbackError);
              });
          }
          throw error;
        }
      });
    } catch (error) {
      await fs.rm(this.versionDirectory(versionId), { recursive: true, force: true });
      throw error;
    }
  }

  private async freezeWorkspaceSkillPins(
    tx: Knex.Transaction,
    sourceWorkspaceId: string,
    teamWorkspaceId: string,
    publishedVersionId: string,
  ): Promise<void> {
    const pins = await this.copyValidatedWorkspaceSkillPins(tx, sourceWorkspaceId, teamWorkspaceId);
    if (pins.length) {
      await tx('published_version_skill_pins').insert(pins.map((pin: any) => ({
        publishedVersionId,
        skillId: pin.skillId,
        skillVersionId: pin.skillVersionId,
        semanticVersion: pin.semanticVersion,
        manifestHash: pin.manifestHash,
      })));
    }
  }

  private async copyValidatedWorkspaceSkillPins(
    tx: Knex.Transaction,
    sourceWorkspaceId: string,
    teamWorkspaceId: string,
  ): Promise<any[]> {
    const pins = await tx('workspace_skill_pins as pin')
      .join('skills as skill', 'skill.id', 'pin.skillId')
      .join('skill_versions as version', 'version.id', 'pin.skillVersionId')
      .select(
        'pin.skillId',
        'pin.skillVersionId',
        'pin.semanticVersion',
        'pin.manifestHash',
        'pin.pinnedByUserId',
        'skill.status as skillStatus',
        'version.status as versionStatus',
        'version.semanticVersion as storedSemanticVersion',
        'version.manifestHash as storedManifestHash',
      )
      .where('pin.workspaceId', sourceWorkspaceId)
      .orderBy('pin.skillId', 'asc');

    const invalid = pins.find((pin: any) =>
      pin.skillStatus !== 'active'
      || pin.versionStatus !== 'active'
      || pin.semanticVersion !== pin.storedSemanticVersion
      || pin.manifestHash !== pin.storedManifestHash);
    if (invalid) {
      throw new ConflictError('Workspace publication contains an unavailable or invalid skill pin', {
        code: 'INVALID_WORKSPACE_SKILL_PIN',
        skillId: invalid.skillId,
        versionId: invalid.skillVersionId,
      });
    }

    if (sourceWorkspaceId !== teamWorkspaceId) {
      await tx('workspace_skill_pins').where({ workspaceId: teamWorkspaceId }).del();
      if (pins.length) {
        await tx('workspace_skill_pins').insert(pins.map((pin: any) => ({
          workspaceId: teamWorkspaceId,
          skillId: pin.skillId,
          skillVersionId: pin.skillVersionId,
          semanticVersion: pin.semanticVersion,
          manifestHash: pin.manifestHash,
          pinnedByUserId: pin.pinnedByUserId,
          validationStatus: 'valid',
        })));
      }
    }
    return pins;
  }

  private async restorePublishedSkillPins(
    tx: Knex.Transaction,
    restoredPublishedVersionId: string,
    workspaceId: string,
    newPublishedVersionId: string,
  ): Promise<void> {
    const pins = await tx('published_version_skill_pins')
      .where({ publishedVersionId: restoredPublishedVersionId })
      .orderBy('skillId', 'asc');
    await tx('workspace_skill_pins').where({ workspaceId }).del();
    if (!pins.length) return;
    await tx('workspace_skill_pins').insert(pins.map((pin: any) => ({
      workspaceId,
      skillId: pin.skillId,
      skillVersionId: pin.skillVersionId,
      semanticVersion: pin.semanticVersion,
      manifestHash: pin.manifestHash,
      pinnedByUserId: null,
      validationStatus: 'valid',
    })));
    await tx('published_version_skill_pins').insert(pins.map((pin: any) => ({
      publishedVersionId: newPublishedVersionId,
      skillId: pin.skillId,
      skillVersionId: pin.skillVersionId,
      semanticVersion: pin.semanticVersion,
      manifestHash: pin.manifestHash,
    })));
  }

  private async copyPublishedSkillPinsToWorkspace(
    tx: Knex.Transaction,
    publishedVersionId: string,
    workspaceId: string,
    pinnedByUserId: string,
  ): Promise<void> {
    const pins = await tx('published_version_skill_pins')
      .where({ publishedVersionId })
      .orderBy('skillId', 'asc');
    await tx('workspace_skill_pins').where({ workspaceId }).del();
    if (!pins.length) return;
    await tx('workspace_skill_pins').insert(pins.map((pin: any) => ({
      workspaceId,
      skillId: pin.skillId,
      skillVersionId: pin.skillVersionId,
      semanticVersion: pin.semanticVersion,
      manifestHash: pin.manifestHash,
      pinnedByUserId,
      validationStatus: 'valid',
    })));
  }

  private ensurePublisher(role: WorkspaceRole): void {
    if (role !== 'owner' && role !== 'editor') {
      throw new AccessDeniedError('Publisher access is required to publish changes');
    }
  }

  private async ensureGroupMembership(groupId: string, userId: string): Promise<void> {
    const group = await this.db('groups').where({ id: groupId }).first();
    if (!group) {
      throw new NotFoundError('Team not found');
    }
    const membership = await this.db('group_members').where({ groupId, userId }).first();
    if (!membership) {
      throw new AccessDeniedError('You are not a member of this team');
    }
  }

  private async getPublishedVersion(versionId: string, teamWorkspaceId: string): Promise<PublishedVersionRecord> {
    const version = await this.db<PublishedVersionRecord>('workspace_published_versions')
      .where({ id: versionId, teamWorkspaceId })
      .first();
    if (!version) {
      throw new NotFoundError('Published version not found');
    }
    return version;
  }

  private async getNextVersionNumber(
    teamWorkspaceId: string,
    database: Knex | Knex.Transaction = this.db,
  ): Promise<number> {
    const row = await database('workspace_published_versions')
      .where({ teamWorkspaceId })
      .max<{ max: string | number | null }>('versionNumber as max')
      .first();
    return Number(row?.max || 0) + 1;
  }

  private normalizeManifest(value: PublicationManifest | PublicationManifestFile[] | string): PublicationManifest {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      return { files: parsed, folders: [] };
    }
    return {
      files: Array.isArray(parsed?.files) ? parsed.files : [],
      folders: Array.isArray(parsed?.folders) ? parsed.folders : [],
    };
  }

  private manifestFromContent(content: WorkspaceContent): PublicationManifest {
    return {
      files: [...content.files.values()]
        .map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          hash: file.hash,
          size: file.size,
          fileVersionId: file.fileVersionId || null,
          objectKey: file.objectKey || null,
          objectProvider: file.objectProvider || null,
          providerVersion: file.providerVersion || null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      folders: [...new Set(content.folders)].sort((left, right) => left.localeCompare(right)),
    };
  }

  private workspaceContentFromManifest(
    value: PublicationManifest | PublicationManifestFile[] | string,
  ): WorkspaceContent {
    const manifest = this.normalizeManifest(value);
    const files = new Map<string, ContentFile>();
    for (const file of manifest.files) {
      const name = this.normalizeRelativePath(file.name);
      files.set(name, {
        name,
        mimeType: file.mimeType || null,
        buffer: Buffer.alloc(0),
        hash: file.hash,
        size: Number(file.size || 0),
        fileVersionId: file.fileVersionId || null,
        objectKey: file.objectKey || null,
        objectProvider: file.objectProvider || null,
        providerVersion: file.providerVersion || null,
      });
    }
    return {
      files,
      folders: manifest.folders.map((folder) => this.normalizeRelativePath(folder)),
    };
  }

  private async readPublishedVersionContent(version: PublishedVersionRecord): Promise<WorkspaceContent> {
    const manifest = this.normalizeManifest(version.manifest);
    const files = new Map<string, ContentFile>();
    for (const file of manifest.files) {
      const safeName = this.normalizeRelativePath(file.name);
      if (file.objectKey) this.assertObjectProvider(file.objectProvider);
      const buffer = file.objectKey
        ? await this.readObjectBuffer(file.objectKey, file.providerVersion || undefined)
        : await fs.readFile(path.join(this.versionDirectory(version.id), safeName));
      files.set(safeName, {
        name: safeName,
        mimeType: file.mimeType || null,
        buffer,
        hash: file.hash,
        size: Number(file.size || buffer.length),
        fileVersionId: file.fileVersionId || null,
        objectKey: file.objectKey || null,
        objectProvider: file.objectProvider || null,
        providerVersion: file.providerVersion || null,
      });
    }
    return { files, folders: manifest.folders.map((folder) => this.normalizeRelativePath(folder)) };
  }

  private async readWorkspaceContent(workspaceId: string): Promise<WorkspaceContent> {
    const rows = await this.db('files as file')
      .leftJoin('file_versions as version', 'file.currentVersionId', 'version.id')
      .select(
        'file.*',
        'version.id as fileVersionId',
        'version.objectKey as versionObjectKey',
        'version.objectProvider as versionObjectProvider',
        'version.providerVersion as versionProviderVersion',
        'version.sha256 as versionSha256',
        'version.sizeBytes as versionSizeBytes',
      )
      .where({ 'file.workspaceId': workspaceId })
      .whereNull('file.deletedAt')
      .orderBy('file.name', 'asc');
    const files = new Map<string, ContentFile>();
    for (const row of rows) {
      if (this.isInternalWorkspacePath(String(row.name || ''))) continue;
      const name = this.normalizeRelativePath(row.name);
      if (row.storageType !== 'local') this.assertObjectProvider(row.versionObjectProvider);
      const buffer = row.storageType === 'local'
        ? await fs.readFile(row.path)
        : await this.readObjectBuffer(row.path, row.versionProviderVersion || undefined);
      files.set(name, {
        name,
        mimeType: row.mimeType || null,
        buffer,
        hash: row.versionSha256 || this.hashBuffer(buffer),
        size: Number(row.versionSizeBytes || buffer.length),
        fileVersionId: row.fileVersionId || null,
        objectKey: row.versionObjectKey || (row.storageType === 's3' ? row.path : null),
        objectProvider: row.versionObjectProvider || (row.storageType === 's3' ? this.objectStore.provider : null),
        providerVersion: row.versionProviderVersion || null,
      });
    }
    return {
      files,
      folders: await this.listVisibleFolders(workspaceId),
    };
  }

  private async writeVersionSnapshot(versionId: string, content: WorkspaceContent): Promise<PublicationManifest> {
    const manifestFiles: PublicationManifestFile[] = [];
    for (const file of content.files.values()) {
      let objectKey = file.objectKey || null;
      let objectProvider = file.objectProvider || null;
      let providerVersion = file.providerVersion || null;
      if (!objectKey) {
        objectKey = path.posix.join('published-versions', versionId, this.normalizeRelativePath(file.name));
        const written = await this.objectStore.putStream(objectKey, Readable.from(file.buffer), {
          mimeType: file.mimeType || undefined,
          contentLength: file.buffer.length,
          sha256: file.hash,
          ifAbsent: true,
        });
        objectProvider = this.objectStore.provider;
        providerVersion = written.providerVersion;
      }
      manifestFiles.push({
        name: file.name,
        mimeType: file.mimeType,
        hash: file.hash,
        size: file.size,
        fileVersionId: file.fileVersionId || null,
        objectKey,
        objectProvider,
        providerVersion,
      });
    }
    return {
      files: manifestFiles.sort((left, right) => left.name.localeCompare(right.name)),
      folders: [...new Set(content.folders)].sort(),
    };
  }

  private async readObjectBuffer(objectKey: string, providerVersion?: string): Promise<Buffer> {
    const { stream } = await this.objectStore.getStream(objectKey, { providerVersion });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private assertObjectProvider(provider?: string | null): void {
    if (provider && provider !== this.objectStore.provider) {
      throw new ConflictError(
        `Published object is stored in ${provider}; migrate and verify it before switching to ${this.objectStore.provider}`,
      );
    }
  }

  private async replaceWorkspaceContent(
    workspaceId: string,
    content: WorkspaceContent,
    userId: string,
    transaction?: Knex.Transaction,
    afterDatabaseUpdate?: (transaction: Knex.Transaction, contentRevision: number) => Promise<void>,
  ): Promise<number> {
    await this.ensureContentObjects(workspaceId, content);
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    const stagePath = path.join(WORKSPACE_DIR, `.workspace-stage-${uuidv4()}`);
    const backupPath = path.join(WORKSPACE_DIR, `.workspace-backup-${uuidv4()}`);
    await fs.mkdir(stagePath, { recursive: true });

    try {
      for (const folder of content.folders) {
        await fs.mkdir(path.join(stagePath, this.normalizeRelativePath(folder)), { recursive: true });
      }
      for (const file of content.files.values()) {
        const destination = path.join(stagePath, this.normalizeRelativePath(file.name));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.buffer);
      }
      await this.copyInternalDirectories(workspacePath, stagePath);

      let hadWorkspaceDirectory = true;
      try {
        await fs.rename(workspacePath, backupPath);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        hadWorkspaceDirectory = false;
      }
      await fs.rename(stagePath, workspacePath);

      try {
        const updateDatabaseRecords = async (tx: Knex | Knex.Transaction) => {
          const existingFiles = await tx('files')
            .where({ workspaceId })
            .whereNull('deletedAt');
          const visibleFiles = existingFiles
            .filter((file) => !this.isInternalWorkspacePath(String(file.name || '')));
          const currentVersionIds = visibleFiles
            .map((file) => file.currentVersionId)
            .filter((versionId): versionId is string => typeof versionId === 'string' && versionId.length > 0);
          const currentVersions = currentVersionIds.length
            ? await tx('file_versions').whereIn('id', currentVersionIds)
            : [];
          const currentVersionById = new Map(
            currentVersions.map((version) => [String(version.id), version]),
          );
          const incomingNames = new Set(content.files.keys());
          const removedFiles = visibleFiles
            .filter((file) => !incomingNames.has(String(file.name)));
          for (const removed of removedFiles) {
            const currentVersion = removed.currentVersionId
              ? currentVersionById.get(String(removed.currentVersionId))
              : undefined;
            const nextVersion = Number(removed.version || 1) + 1;
            const tombstoneVersionId = uuidv4();
            if (currentVersion?.objectKey) {
              await tx('file_versions').insert({
                id: tombstoneVersionId,
                fileId: removed.id,
                workspaceId,
                version: nextVersion,
                name: String(removed.name),
                mimeType: removed.mimeType || currentVersion.mimeType || null,
                objectKey: currentVersion.objectKey,
                objectProvider: currentVersion.objectProvider || this.objectStore.provider,
                providerVersion: currentVersion.providerVersion || null,
                sha256: currentVersion.sha256 || null,
                sizeBytes: currentVersion.sizeBytes || 0,
                changeKind: 'delete',
                baseVersion: Number(removed.version || 1),
                createdBy: userId,
              });
            }
            await tx('files').where({ id: removed.id }).update({
              ...(currentVersion?.objectKey ? { currentVersionId: tombstoneVersionId } : {}),
              version: nextVersion,
              deletedAt: tx.fn.now(),
              updatedBy: userId,
              updatedAt: tx.fn.now(),
            });
          }
          const existingByName = new Map(visibleFiles.map((file) => [String(file.name), file]));
          for (const file of content.files.values()) {
            const existing = existingByName.get(file.name);
            const currentVersion = existing?.currentVersionId
              ? currentVersionById.get(String(existing.currentVersionId))
              : undefined;
            const contentIsUnchanged = Boolean(existing && currentVersion)
              && String(currentVersion.sha256 || '') === file.hash
              && String(currentVersion.name || existing.name) === file.name
              && (currentVersion.mimeType || null) === (file.mimeType || null);
            if (contentIsUnchanged) continue;
            const nextVersion = existing ? Number(existing.version || 1) + 1 : 1;
            const versionId = uuidv4();
            let fileId: number;
            if (existing) {
              fileId = Number(existing.id);
              await tx('files').where({ id: fileId }).update({
                storageType: 's3',
                path: file.objectKey,
                mimeType: file.mimeType,
                publicUrl: null,
                currentVersionId: versionId,
                updatedBy: userId,
                updatedAt: tx.fn.now(),
                version: nextVersion,
              });
            } else {
              const [created] = await tx('files').insert({
                name: file.name,
                workspaceId,
                storageType: 's3',
                path: file.objectKey,
                mimeType: file.mimeType,
                publicUrl: null,
                currentVersionId: versionId,
                createdBy: userId,
                updatedBy: userId,
                version: nextVersion,
              }).returning('id');
              fileId = Number(created.id);
            }
            await tx('file_versions').insert({
              id: versionId,
              fileId,
              workspaceId,
              version: nextVersion,
              name: file.name,
              mimeType: file.mimeType,
              objectKey: file.objectKey,
              objectProvider: file.objectProvider || this.objectStore.provider,
              providerVersion: file.providerVersion || null,
              sha256: file.hash,
              sizeBytes: file.size,
              changeKind: existing ? 'content' : 'create',
              baseVersion: existing ? Number(existing.version || 1) : null,
              createdBy: userId,
            });
          }
          const [updated] = await tx('workspaces')
            .where({ id: workspaceId })
            .update({
              contentRevision: tx.raw('COALESCE("contentRevision", 0) + 1'),
              updatedAt: tx.fn.now(),
              lastModifiedBy: userId,
            })
            .returning('contentRevision');
          return Number(updated?.contentRevision || 0);
        };
        const applyDatabaseChanges = async (tx: Knex.Transaction) => {
          const contentRevision = await updateDatabaseRecords(tx);
          await afterDatabaseUpdate?.(tx, contentRevision);
          return contentRevision;
        };
        const contentRevision = transaction
          ? await applyDatabaseChanges(transaction)
          : await this.db.transaction(applyDatabaseChanges);
        await fs.rm(backupPath, { recursive: true, force: true });
        return contentRevision;
      } catch (error) {
        await fs.rm(workspacePath, { recursive: true, force: true });
        if (hadWorkspaceDirectory) {
          await fs.rename(backupPath, workspacePath);
        }
        throw error;
      }
    } finally {
      await fs.rm(stagePath, { recursive: true, force: true });
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  }

  private async ensureContentObjects(workspaceId: string, content: WorkspaceContent): Promise<void> {
    for (const file of content.files.values()) {
      if (file.objectKey) continue;
      const versionId = uuidv4();
      const objectKey = path.posix.join(workspaceId, '.system', 'file-versions', versionId);
      const written = await this.objectStore.putStream(objectKey, Readable.from(file.buffer), {
        mimeType: file.mimeType || undefined,
        contentLength: file.buffer.length,
        sha256: file.hash,
        ifAbsent: true,
      });
      file.objectKey = objectKey;
      file.objectProvider = this.objectStore.provider;
      file.providerVersion = written.providerVersion;
    }
  }

  private mergeWorkspaceContent(
    base: WorkspaceContent,
    privateContent: WorkspaceContent,
    teamContent: WorkspaceContent,
    resolutions: Record<string, PublishResolution>,
  ): WorkspaceContent {
    const files = new Map<string, ContentFile>();
    const paths = new Set([...base.files.keys(), ...privateContent.files.keys(), ...teamContent.files.keys()]);

    for (const filePath of paths) {
      const baseFile = base.files.get(filePath);
      const privateFile = privateContent.files.get(filePath);
      const teamFile = teamContent.files.get(filePath);
      const privateChanged = hasFileChanged(baseFile, privateFile);
      const teamChanged = hasFileChanged(baseFile, teamFile);
      const versionsDiffer = hasFileChanged(privateFile, teamFile);

      let selected: ContentFile | undefined;
      if (privateChanged && teamChanged && versionsDiffer) {
        selected = resolutions[filePath] === 'team' ? teamFile : privateFile;
      } else if (teamChanged) {
        selected = teamFile;
      } else {
        selected = privateFile;
      }
      if (selected) files.set(filePath, selected);
    }

    return {
      files,
      folders: mergePublicationFolders(
        base.folders,
        privateContent.folders,
        teamContent.folders,
        files.keys(),
      ),
    };
  }

  private toHashMap(content: WorkspaceContent): Map<string, { hash: string }> {
    return new Map([...content.files.entries()].map(([filePath, file]) => [filePath, { hash: file.hash }]));
  }

  private presentConflicts(
    conflicts: PublicationConflict[],
    privateContent: WorkspaceContent,
    teamContent: WorkspaceContent,
  ) {
    return conflicts.map((conflict) => {
      const privateFile = privateContent.files.get(conflict.path);
      const teamFile = teamContent.files.get(conflict.path);
      const canCompareText = this.isTextContent(privateFile) && this.isTextContent(teamFile);
      return {
        ...conflict,
        ...(canCompareText
          ? {
              privateText: privateFile!.buffer.toString('utf-8').slice(0, 20_000),
              teamText: teamFile!.buffer.toString('utf-8').slice(0, 20_000),
              textTruncated: privateFile!.size > 20_000 || teamFile!.size > 20_000,
            }
          : {}),
      };
    });
  }

  private isTextContent(file: ContentFile | undefined): boolean {
    if (!file) return false;
    const mimeType = String(file.mimeType || '').toLowerCase();
    if (
      mimeType.startsWith('text/')
      || mimeType === 'application/json'
      || mimeType === 'application/javascript'
      || mimeType === 'image/svg+xml'
    ) {
      return true;
    }
    return ['.md', '.txt', '.json', '.csv', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.svg', '.yaml', '.yml']
      .includes(path.extname(file.name).toLowerCase());
  }

  private workspaceContentsMatch(left: WorkspaceContent, right: WorkspaceContent): boolean {
    if (left.files.size !== right.files.size) return false;
    for (const [filePath, leftFile] of left.files) {
      if (right.files.get(filePath)?.hash !== leftFile.hash) return false;
    }
    const leftFolders = [...new Set(left.folders)].sort();
    const rightFolders = [...new Set(right.folders)].sort();
    return leftFolders.length === rightFolders.length
      && leftFolders.every((folder, index) => folder === rightFolders[index]);
  }

  private async copyInternalDirectories(sourceRoot: string, destinationRoot: string): Promise<void> {
    let entries: Array<import('fs').Dirent> = [];
    try {
      entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.')) continue;
      await fs.cp(
        path.join(sourceRoot, entry.name),
        path.join(destinationRoot, entry.name),
        { recursive: true },
      );
    }
  }

  private async listVisibleFolders(workspaceId: string): Promise<string[]> {
    const root = path.join(WORKSPACE_DIR, workspaceId);
    const result: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const absolute = path.join(current, entry.name);
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        if (!this.isInternalWorkspacePath(relative)) {
          result.push(relative);
          await walk(absolute);
        }
      }
    };
    await walk(root);
    return result.sort();
  }

  private async resolveUniquePrivateCopyName(userId: string, baseName: string): Promise<string> {
    const existing = await this.db('workspaces')
      .where({ ownerId: userId, visibility: 'private' })
      .select('name');
    const names = new Set(existing.map((row) => String(row.name).toLowerCase()));
    if (!names.has(baseName.toLowerCase())) return baseName;
    let suffix = 2;
    while (names.has(`${baseName} (${suffix})`.toLowerCase())) suffix += 1;
    return `${baseName} (${suffix})`;
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'workspace';
    let candidate = base;
    let counter = 1;
    while (await this.db('workspaces').where({ slug: candidate }).first()) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private toPrivateWorkspaceResponse(workspace: WorkspaceRecord, teamWorkspaceId: string) {
    return {
      ...workspace,
      role: 'owner' as const,
      canEdit: true,
      visibility: 'private' as const,
      publicationStatus: 'up_to_date' as const,
      linkedTeamWorkspaceId: teamWorkspaceId,
    };
  }

  private normalizeRelativePath(value: string): string {
    const normalized = path.posix.normalize(String(value || '').replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new ConflictError('Invalid workspace content path');
    }
    return normalized;
  }

  private isInternalWorkspacePath(value: string): boolean {
    const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.some((part) => INTERNAL_WORKSPACE_DIR_NAMES.has(part.toLowerCase()) || part.startsWith('.'));
  }

  private versionDirectory(versionId: string): string {
    return path.join(VERSION_ROOT, versionId);
  }

  private hashBuffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
