import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

import { AccessDeniedError, ConflictError, HttpError, NotFoundError } from '../errors';
import { DatabaseService } from './databaseService';
import { WorkspacePublicationService } from './workspacePublicationService';
import { WorkspaceMembershipRecord, WorkspaceService } from './workspaceService';
import {
  canCreateWorkspaceCollaborationObject,
  canModerateWorkspaceCollaboration,
  getWorkspaceRoleCapabilities,
  type WorkspaceCollaborationObjectType,
  type WorkspaceCollaborationVisibility,
} from './workspaceCollaborationPolicy';

export type WorkspaceCollaborationStatus =
  | 'open'
  | 'discussing'
  | 'proposed'
  | 'resolved'
  | 'addressed'
  | 'anchor_changed';

export type WorkspaceCollaborationObject = {
  id: string;
  workspaceId: string;
  originVersionId: string | null;
  type: WorkspaceCollaborationObjectType;
  visibility: WorkspaceCollaborationVisibility;
  status: WorkspaceCollaborationStatus;
  fileId: number | null;
  filePath: string | null;
  blockId: string | null;
  anchorText: string | null;
  anchorStart: number | null;
  anchorEnd: number | null;
  anchorFingerprint: string | null;
  title: string | null;
  body: string;
  authorId: string | null;
  authorName?: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  linkedPrivateWorkspaceId: string | null;
  resolvedByVersionId: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
};

export type CreateWorkspaceCollaborationInput = {
  type: WorkspaceCollaborationObjectType;
  visibility: WorkspaceCollaborationVisibility;
  title?: string;
  body: string;
  fileId?: number;
  filePath?: string;
  blockId?: string;
  anchorText?: string;
  anchorStart?: number;
  anchorEnd?: number;
  anchorFingerprint?: string;
  assigneeId?: string;
  dueAt?: string;
  mentionedUserIds?: string[];
};

export type UpdateWorkspaceCollaborationInput = {
  status?: WorkspaceCollaborationStatus;
  assigneeId?: string | null;
  dueAt?: string | null;
};

type CollaborationAccess = {
  membership: WorkspaceMembershipRecord;
  currentPublishedVersionId: string | null;
};

export class WorkspaceCollaborationService {
  private readonly db: Knex;
  private readonly workspaceService: WorkspaceService;
  private readonly publicationService: WorkspacePublicationService;

  constructor(
    databaseService: DatabaseService,
    workspaceService: WorkspaceService,
    publicationService: WorkspacePublicationService,
  ) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.publicationService = publicationService;
  }

  async listObjects(
    workspaceId: string,
    userId: string,
    filters: {
      status?: WorkspaceCollaborationStatus;
      type?: WorkspaceCollaborationObjectType;
      filePath?: string;
    } = {},
  ): Promise<WorkspaceCollaborationObject[]> {
    await this.ensurePublishedWorkspaceAccess(workspaceId, userId);

    const rows = await this.db('workspace_collaboration_objects as object')
      .leftJoin('users as author', 'author.id', 'object.authorId')
      .leftJoin('users as assignee', 'assignee.id', 'object.assigneeId')
      .where('object.workspaceId', workspaceId)
      .andWhere((query) => {
        query
          .where('object.visibility', 'workspace_audience')
          .orWhere('object.authorId', userId);
      })
      .modify((query) => {
        if (filters.status) query.where('object.status', filters.status);
        if (filters.type) query.where('object.type', filters.type);
        if (filters.filePath) query.where('object.filePath', filters.filePath);
      })
      .select(
        'object.*',
        this.db.raw(`COALESCE(author."displayName", 'Former user') as "authorName"`),
        'assignee.displayName as assigneeName',
        this.db.raw(`(
          SELECT COUNT(*)::int
          FROM workspace_collaboration_messages message
          WHERE message."objectId" = object.id
        ) as "messageCount"`),
      )
      .orderBy('object.updatedAt', 'desc');

    return rows as WorkspaceCollaborationObject[];
  }

  async getObject(
    workspaceId: string,
    objectId: string,
    userId: string,
  ): Promise<{
    object: WorkspaceCollaborationObject;
    messages: Array<{
      id: string;
      authorId: string | null;
      authorName: string;
      body: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }> {
    await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    const messages = await this.db('workspace_collaboration_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.objectId', objectId)
      .select(
        'message.*',
        this.db.raw(`COALESCE(author."displayName", 'Former user') as "authorName"`),
      )
      .orderBy('message.createdAt', 'asc');
    return { object, messages };
  }

  async createObject(
    workspaceId: string,
    userId: string,
    input: CreateWorkspaceCollaborationInput,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    if (!canCreateWorkspaceCollaborationObject(access.membership.role, input.type, input.visibility)) {
      throw new AccessDeniedError(
        input.type === 'change_proposal'
          ? 'Contributor access is required to create a proposal'
          : 'Commenter access is required to create shared collaboration items',
      );
    }
    if (input.type === 'change_proposal' && input.visibility !== 'workspace_audience') {
      throw new HttpError(400, 'Change proposals must be visible to the workspace audience');
    }
    if (input.visibility === 'private' && input.mentionedUserIds?.length) {
      throw new HttpError(400, 'Private notes cannot mention or notify other users');
    }
    if (input.assigneeId && input.type !== 'task') {
      throw new HttpError(400, 'Only tasks can have an assignee');
    }

    const mentionedUserIds = Array.from(new Set(input.mentionedUserIds || []));
    for (const mentionedUserId of mentionedUserIds) {
      await this.ensureMentionTargetHasAccess(workspaceId, mentionedUserId);
    }
    if (input.assigneeId) {
      await this.ensureMentionTargetHasAccess(workspaceId, input.assigneeId);
    }

    const id = uuidv4();
    await this.db.transaction(async (tx) => {
      await tx('workspace_collaboration_objects').insert({
        id,
        workspaceId,
        originVersionId: access.currentPublishedVersionId,
        type: input.type,
        visibility: input.visibility,
        status: input.type === 'change_proposal' ? 'proposed' : 'open',
        fileId: input.fileId || null,
        filePath: this.optionalText(input.filePath),
        blockId: this.optionalText(input.blockId),
        anchorText: this.optionalText(input.anchorText),
        anchorStart: input.anchorStart ?? null,
        anchorEnd: input.anchorEnd ?? null,
        anchorFingerprint: this.optionalText(input.anchorFingerprint),
        title: this.optionalText(input.title),
        body: input.body.trim(),
        authorId: userId,
        assigneeId: input.assigneeId || null,
        dueAt: input.dueAt || null,
      });
      if (mentionedUserIds.length) {
        await tx('workspace_collaboration_mentions').insert(
          mentionedUserIds.map((mentionedUserId) => ({
            objectId: id,
            userId: mentionedUserId,
          })),
        );
      }
    });

    return this.ensureObjectAccess(workspaceId, id, userId);
  }

  async appendMessage(
    workspaceId: string,
    objectId: string,
    userId: string,
    body: string,
  ) {
    const { membership } = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (
      object.visibility === 'workspace_audience'
      && !getWorkspaceRoleCapabilities(membership.role).canComment
    ) {
      throw new AccessDeniedError('Commenter access is required to reply');
    }

    const [message] = await this.db('workspace_collaboration_messages')
      .insert({
        id: uuidv4(),
        objectId,
        authorId: userId,
        body: body.trim(),
      })
      .returning('*');
    await this.db('workspace_collaboration_objects')
      .where({ id: objectId })
      .update({
        status: object.status === 'open' ? 'discussing' : object.status,
        updatedAt: this.db.fn.now(),
      });
    return message;
  }

  async updateObject(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: UpdateWorkspaceCollaborationInput,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    const canModerate = canModerateWorkspaceCollaboration(access.membership.role);
    const canManageItem = canModerate
      || object.authorId === userId
      || (object.type === 'task' && object.assigneeId === userId);
    if (!canManageItem) {
      throw new AccessDeniedError('Only the author, assignee, or a Publisher can update this item');
    }
    if (input.assigneeId) {
      if (object.type !== 'task') {
        throw new HttpError(400, 'Only tasks can have an assignee');
      }
      await this.ensureMentionTargetHasAccess(workspaceId, input.assigneeId);
    }

    const resolved = input.status === 'resolved' || input.status === 'addressed';
    await this.db('workspace_collaboration_objects')
      .where({ id: objectId })
      .update({
        ...(input.status ? { status: input.status } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...(resolved
          ? {
            resolvedAt: this.db.fn.now(),
            resolvedByVersionId: canModerate ? access.currentPublishedVersionId : object.resolvedByVersionId,
          }
          : input.status
            ? { resolvedAt: null, resolvedByVersionId: null }
            : {}),
        updatedAt: this.db.fn.now(),
      });

    return this.ensureObjectAccess(workspaceId, objectId, userId);
  }

  async convertToProposal(
    workspaceId: string,
    objectId: string,
    userId: string,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    if (!getWorkspaceRoleCapabilities(access.membership.role).canPropose) {
      throw new AccessDeniedError('Contributor access is required to create a proposal');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.visibility !== 'workspace_audience') {
      throw new ConflictError('Make the item visible to the workspace before converting it to a proposal');
    }

    const privateWorkspace = await this.publicationService.createPrivateCopy(workspaceId, userId);
    await this.db('workspace_collaboration_objects')
      .where({ id: objectId })
      .update({
        type: 'change_proposal',
        status: 'proposed',
        linkedPrivateWorkspaceId: privateWorkspace.id,
        updatedAt: this.db.fn.now(),
      });
    return this.ensureObjectAccess(workspaceId, objectId, userId);
  }

  private async ensurePublishedWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<CollaborationAccess> {
    const { workspace, membership } = await this.workspaceService.ensureMembership(workspaceId, userId);
    if (workspace.visibility !== 'team') {
      throw new ConflictError('Collaboration items are attached to published workspaces');
    }
    let currentPublishedVersionId = workspace.currentPublishedVersionId || null;
    if (!currentPublishedVersionId) {
      await this.publicationService.listHistory(workspaceId, userId);
      const refreshed = await this.db('workspaces')
        .select('currentPublishedVersionId')
        .where({ id: workspaceId })
        .first();
      currentPublishedVersionId = refreshed?.currentPublishedVersionId || null;
    }
    return {
      membership,
      currentPublishedVersionId,
    };
  }

  private async ensureObjectAccess(
    workspaceId: string,
    objectId: string,
    userId: string,
  ): Promise<WorkspaceCollaborationObject> {
    const object = await this.db('workspace_collaboration_objects as object')
      .leftJoin('users as author', 'author.id', 'object.authorId')
      .leftJoin('users as assignee', 'assignee.id', 'object.assigneeId')
      .where('object.id', objectId)
      .andWhere('object.workspaceId', workspaceId)
      .select(
        'object.*',
        this.db.raw(`COALESCE(author."displayName", 'Former user') as "authorName"`),
        'assignee.displayName as assigneeName',
        this.db.raw(`(
          SELECT COUNT(*)::int
          FROM workspace_collaboration_messages message
          WHERE message."objectId" = object.id
        ) as "messageCount"`),
      )
      .first() as WorkspaceCollaborationObject | undefined;
    if (!object) {
      throw new NotFoundError('Collaboration item not found');
    }
    if (object.visibility === 'private' && object.authorId !== userId) {
      throw new NotFoundError('Collaboration item not found');
    }
    return object;
  }

  private async ensureMentionTargetHasAccess(workspaceId: string, targetUserId: string): Promise<void> {
    try {
      await this.workspaceService.ensureMembership(workspaceId, targetUserId);
    } catch {
      throw new HttpError(400, 'Mentioned users must already have access to the workspace');
    }
  }

  private optionalText(value: string | undefined): string | null {
    const normalized = value?.trim();
    return normalized || null;
  }
}
