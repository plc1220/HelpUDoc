import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import { DatabaseService } from './databaseService';
import { S3Service } from './s3Service';
import { WorkspaceRecord, WorkspaceRole, WorkspaceService } from './workspaceService';
import {
  findPublicationConflicts,
  hasFileChanged,
  mergePublicationFolders,
  type PublicationConflict,
} from './workspacePublicationDiff';

const WORKSPACE_DIR = resolveWorkspaceRoot();
const VERSION_ROOT = path.join(WORKSPACE_DIR, '.published-versions');
const INTERNAL_WORKSPACE_DIR_NAMES = new Set(['.system']);

type PublishResolution = 'private' | 'team';

type ContentFile = {
  name: string;
  mimeType: string | null;
  buffer: Buffer;
  hash: string;
  size: number;
};

type PublicationManifestFile = {
  name: string;
  mimeType: string | null;
  hash: string;
  size: number;
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
  hasUnpublishedChanges: boolean;
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
  private readonly s3Service: S3Service;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.s3Service = new S3Service();
  }

  async publish(
    privateWorkspaceId: string,
    userId: string,
    input: { teamId?: string; note?: string; name?: string },
  ) {
    const { workspace: privateWorkspace } = await this.workspaceService.ensureMembership(
      privateWorkspaceId,
      userId,
      { requireEdit: true },
    );
    if (privateWorkspace.visibility !== 'private' || privateWorkspace.ownerId !== userId) {
      throw new AccessDeniedError('Only the owner can publish a private workspace');
    }

    const existingLink = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ privateWorkspaceId })
      .first();

    if (!existingLink) {
      if (!input.teamId) {
        throw new ConflictError('Choose a team before publishing');
      }
      await this.ensureGroupMembership(input.teamId, userId);
      return this.publishFirstVersion(privateWorkspace, userId, {
        teamId: input.teamId,
        note: input.note,
        name: input.name,
      });
    }

    const { workspace: teamWorkspace, membership } = await this.workspaceService.ensureMembership(
      existingLink.teamWorkspaceId,
      userId,
    );
    this.ensurePublisher(membership.role);

    if (teamWorkspace.currentPublishedVersionId !== existingLink.basePublishedVersionId) {
      throw new ConflictError('Team updates must be reviewed before publishing', {
        code: 'TEAM_UPDATES_AVAILABLE',
        teamWorkspaceId: teamWorkspace.id,
      });
    }

    if (
      !existingLink.hasUnpublishedChanges
      && Number(privateWorkspace.contentRevision || 0) === Number(existingLink.basePrivateContentRevision || 0)
    ) {
      throw new ConflictError('There are no private changes to publish');
    }

    return this.createPublishedVersion({
      privateWorkspace,
      teamWorkspace,
      userId,
      note: input.note,
      existingLink,
    });
  }

  async createPrivateCopy(teamWorkspaceId: string, userId: string) {
    const { workspace: teamWorkspace } = await this.workspaceService.ensureMembership(teamWorkspaceId, userId);
    if (teamWorkspace.visibility !== 'team') {
      throw new ConflictError('A private copy can only be created from a team workspace');
    }

    const existing = await this.db<PublicationLinkRecord>('workspace_publication_links')
      .where({ teamWorkspaceId, userId })
      .first();
    if (existing) {
      const workspace = await this.db<WorkspaceRecord>('workspaces')
        .where({ id: existing.privateWorkspaceId })
        .first();
      if (workspace) {
        return this.toPrivateWorkspaceResponse(workspace, teamWorkspaceId);
      }
    }

    const currentVersion = await this.ensureCurrentVersion(teamWorkspace, userId);
    const content = await this.readPublishedVersionContent(currentVersion);
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
        contentRevision: 0,
      });
      await tx('workspace_members').insert({
        workspaceId: privateWorkspaceId,
        userId,
        role: 'owner',
        canEdit: true,
      });
    });

    try {
      const contentRevision = await this.replaceWorkspaceContent(privateWorkspaceId, content, userId);
      await this.db('workspace_publication_links').insert({
        privateWorkspaceId,
        teamWorkspaceId,
        userId,
        basePublishedVersionId: currentVersion.id,
        basePrivateContentRevision: contentRevision,
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
      throw new ConflictError('This private workspace is not linked to a team workspace');
    }

    const { workspace: teamWorkspace } = await this.workspaceService.ensureMembership(link.teamWorkspaceId, userId);
    const latestVersion = await this.ensureCurrentVersion(teamWorkspace, userId);
    if (latestVersion.id === link.basePublishedVersionId) {
      return {
        workspaceId: privateWorkspaceId,
        teamWorkspaceId: teamWorkspace.id,
        status: 'up_to_date',
        conflicts: [],
      };
    }

    const baseVersion = link.basePublishedVersionId
      ? await this.getPublishedVersion(link.basePublishedVersionId, teamWorkspace.id)
      : null;
    const [privateContent, teamContent, baseContent] = await Promise.all([
      this.readWorkspaceContent(privateWorkspaceId),
      this.readPublishedVersionContent(latestVersion),
      baseVersion ? this.readPublishedVersionContent(baseVersion) : Promise.resolve({ files: new Map(), folders: [] }),
    ]);

    const conflicts = findPublicationConflicts(
      this.toHashMap(baseContent),
      this.toHashMap(privateContent),
      this.toHashMap(teamContent),
    );
    const unresolved = conflicts.filter((conflict) => !resolutions[conflict.path]);
    if (unresolved.length) {
      throw new ConflictError('Review overlapping workspace changes before syncing', {
        code: 'REVIEW_NEEDED',
        conflicts: this.presentConflicts(unresolved, privateContent, teamContent),
      });
    }

    const merged = this.mergeWorkspaceContent(baseContent, privateContent, teamContent, resolutions);
    await this.replaceWorkspaceContent(
      privateWorkspaceId,
      merged,
      userId,
      undefined,
      async (tx, contentRevision) => {
        const updated = await tx('workspace_publication_links')
          .where({ privateWorkspaceId, userId })
          .update({
            basePublishedVersionId: latestVersion.id,
            basePrivateContentRevision: contentRevision,
            hasUnpublishedChanges: !this.workspaceContentsMatch(merged, teamContent),
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
      status: conflicts.length ? 'reviewed' : 'synced',
      conflicts,
      publishedVersionId: latestVersion.id,
      publishedVersionNumber: Number(latestVersion.versionNumber),
    };
  }

  async listHistory(teamWorkspaceId: string, userId: string) {
    const { workspace } = await this.workspaceService.ensureMembership(teamWorkspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Publication history is only available for team workspaces');
    }
    await this.ensureCurrentVersion(workspace, userId);
    return this.db('workspace_published_versions as version')
      .leftJoin('users as publisher', 'publisher.id', 'version.publisherUserId')
      .where('version.teamWorkspaceId', teamWorkspaceId)
      .select(
        'version.id',
        'version.versionNumber',
        'version.note',
        'version.createdAt',
        this.db.raw(`COALESCE(publisher."displayName", 'Former user') as "publisherName"`),
      )
      .orderBy('version.versionNumber', 'desc');
  }

  async restore(teamWorkspaceId: string, versionId: string, userId: string) {
    const { workspace: teamWorkspace, membership } = await this.workspaceService.ensureMembership(
      teamWorkspaceId,
      userId,
    );
    if (teamWorkspace.visibility !== 'team' || membership.role !== 'owner') {
      throw new AccessDeniedError('Only the Team owner can restore a published version');
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
          throw new NotFoundError('Team workspace not found');
        }
        const currentOwnerMembership = await tx('workspace_members')
          .select('role')
          .where({ workspaceId: lockedTeam.id, userId })
          .forShare()
          .first() as { role?: WorkspaceRole } | undefined;
        if (currentOwnerMembership?.role !== 'owner') {
          throw new AccessDeniedError('Only the Team owner can restore a published version');
        }
        if (lockedTeam.teamId) {
          const currentGroupMembership = await tx('group_members')
            .where({ groupId: lockedTeam.teamId, userId })
            .forShare()
            .first();
          if (!currentGroupMembership) {
            throw new AccessDeniedError('Team membership is required to restore a published version');
          }
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
          await this.replaceWorkspaceContent(teamWorkspaceId, content, userId, tx);
          const [created] = await tx<PublishedVersionRecord>('workspace_published_versions')
            .insert({
              id: newVersionId,
              teamWorkspaceId,
              versionNumber: nextVersionNumber,
              sourcePrivateWorkspaceId: null,
              publisherUserId: userId,
              note: `Restored version ${restoredVersion.versionNumber}`,
              manifest,
            })
            .returning('*');
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

  private async publishFirstVersion(
    privateWorkspace: WorkspaceRecord,
    userId: string,
    input: { teamId: string; note?: string; name?: string },
  ) {
    const teamWorkspaceId = uuidv4();
    const resolvedName = String(input.name || privateWorkspace.name).trim().slice(0, 255) || privateWorkspace.name;
    const slug = await this.generateUniqueSlug(resolvedName);

    await this.db.transaction(async (tx) => {
      await tx('workspaces').insert({
        id: teamWorkspaceId,
        name: resolvedName,
        slug,
        ownerId: userId,
        lastModifiedBy: userId,
        visibility: 'team',
        teamId: input.teamId,
        contentRevision: 0,
      });
      await tx('workspace_members').insert({
        workspaceId: teamWorkspaceId,
        userId,
        role: 'owner',
        canEdit: false,
      });
    });

    const teamWorkspace = await this.db<WorkspaceRecord>('workspaces').where({ id: teamWorkspaceId }).first();
    if (!teamWorkspace) {
      throw new NotFoundError('Team workspace was not created');
    }

    try {
      return await this.createPublishedVersion({
        privateWorkspace,
        teamWorkspace,
        userId,
        note: input.note,
        existingLink: null,
      });
    } catch (error) {
      await this.db('workspaces').where({ id: teamWorkspaceId }).del();
      await fs.rm(path.join(WORKSPACE_DIR, teamWorkspaceId), { recursive: true, force: true });
      throw error;
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
          throw new NotFoundError('Team workspace not found');
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
        if (lockedTeam.teamId) {
          const currentGroupMembership = await tx('group_members')
            .where({ groupId: lockedTeam.teamId, userId: input.userId })
            .forShare()
            .first();
          if (!currentGroupMembership) {
            throw new AccessDeniedError('Team membership is required to publish changes');
          }
        }
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
          await this.replaceWorkspaceContent(lockedTeam.id, content, input.userId, tx);
          const [version] = await tx<PublishedVersionRecord>('workspace_published_versions')
            .insert({
              id: versionId,
              teamWorkspaceId: lockedTeam.id,
              versionNumber,
              sourcePrivateWorkspaceId: input.privateWorkspace.id,
              publisherUserId: input.userId,
              note: String(input.note || '').trim() || null,
              manifest,
            })
            .returning('*');

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
            hasUnpublishedChanges: false,
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

  private async ensureCurrentVersion(
    teamWorkspace: WorkspaceRecord,
    userId: string,
  ): Promise<PublishedVersionRecord> {
    if (teamWorkspace.currentPublishedVersionId) {
      return this.getPublishedVersion(teamWorkspace.currentPublishedVersionId, teamWorkspace.id);
    }

    // Legacy shared workspaces are frozen as team workspaces during migration.
    // Their first immutable version is created lazily when publication features are used.
    const content = await this.readWorkspaceContent(teamWorkspace.id);
    const versionId = uuidv4();
    const manifest = await this.writeVersionSnapshot(versionId, content);
    const publisherUserId = teamWorkspace.ownerId || userId;
    const [version] = await this.db<PublishedVersionRecord>('workspace_published_versions')
      .insert({
        id: versionId,
        teamWorkspaceId: teamWorkspace.id,
        versionNumber: 1,
        sourcePrivateWorkspaceId: null,
        publisherUserId,
        note: 'Initial published version',
        manifest,
      })
      .returning('*');
    await this.db('workspaces')
      .where({ id: teamWorkspace.id })
      .whereNull('currentPublishedVersionId')
      .update({ currentPublishedVersionId: version.id });
    return version;
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

  private async readPublishedVersionContent(version: PublishedVersionRecord): Promise<WorkspaceContent> {
    const manifest = this.normalizeManifest(version.manifest);
    const files = new Map<string, ContentFile>();
    for (const file of manifest.files) {
      const safeName = this.normalizeRelativePath(file.name);
      const buffer = await fs.readFile(path.join(this.versionDirectory(version.id), safeName));
      files.set(safeName, {
        name: safeName,
        mimeType: file.mimeType || null,
        buffer,
        hash: file.hash,
        size: Number(file.size || buffer.length),
      });
    }
    return { files, folders: manifest.folders.map((folder) => this.normalizeRelativePath(folder)) };
  }

  private async readWorkspaceContent(workspaceId: string): Promise<WorkspaceContent> {
    const rows = await this.db('files').where({ workspaceId }).orderBy('name', 'asc');
    const files = new Map<string, ContentFile>();
    for (const row of rows) {
      if (this.isInternalWorkspacePath(String(row.name || ''))) continue;
      const name = this.normalizeRelativePath(row.name);
      const buffer = row.storageType === 'local'
        ? await fs.readFile(row.path)
        : await this.s3Service.getFile(row.path);
      files.set(name, {
        name,
        mimeType: row.mimeType || null,
        buffer,
        hash: this.hashBuffer(buffer),
        size: buffer.length,
      });
    }
    return {
      files,
      folders: await this.listVisibleFolders(workspaceId),
    };
  }

  private async writeVersionSnapshot(versionId: string, content: WorkspaceContent): Promise<PublicationManifest> {
    const target = this.versionDirectory(versionId);
    await fs.mkdir(target, { recursive: true });
    const manifestFiles: PublicationManifestFile[] = [];
    for (const file of content.files.values()) {
      const destination = path.join(target, this.normalizeRelativePath(file.name));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.buffer);
      manifestFiles.push({
        name: file.name,
        mimeType: file.mimeType,
        hash: file.hash,
        size: file.size,
      });
    }
    return {
      files: manifestFiles.sort((left, right) => left.name.localeCompare(right.name)),
      folders: [...new Set(content.folders)].sort(),
    };
  }

  private async replaceWorkspaceContent(
    workspaceId: string,
    content: WorkspaceContent,
    userId: string,
    transaction?: Knex.Transaction,
    afterDatabaseUpdate?: (transaction: Knex.Transaction, contentRevision: number) => Promise<void>,
  ): Promise<number> {
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
          const existingFiles = await tx('files').where({ workspaceId });
          const visibleIds = existingFiles
            .filter((file) => !this.isInternalWorkspacePath(String(file.name || '')))
            .map((file) => file.id);
          if (visibleIds.length) {
            await tx('files').whereIn('id', visibleIds).del();
          }
          if (content.files.size) {
            await tx('files').insert([...content.files.values()].map((file) => ({
              name: file.name,
              workspaceId,
              storageType: 'local',
              path: path.join(workspacePath, file.name),
              mimeType: file.mimeType,
              publicUrl: null,
              createdBy: userId,
              updatedBy: userId,
              version: 1,
            })));
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
