import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

import { AccessDeniedError, ConflictError, HttpError, NotFoundError } from '../errors';
import { DatabaseService } from './databaseService';
import { WorkspacePublicationService } from './workspacePublicationService';
import { WorkspaceMembershipRecord, WorkspaceService } from './workspaceService';
import {
  canCreateWorkspaceCollaborationObject,
  canModerateWorkspaceCollaboration,
  canPostWorkspaceTeamMessage,
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
  sourceTeamMessageId: string | null;
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
  sourceTeamMessageId?: string;
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

export type WorkspaceTeamMessageAuthorType = 'user' | 'lumo' | 'system';

export type WorkspaceTeamMessage = {
  id: string;
  workspaceId: string;
  originVersionId: string | null;
  originVersionNumber: number | null;
  authorId: string | null;
  authorType: WorkspaceTeamMessageAuthorType;
  authorName: string;
  body: string;
  replyToMessageId: string | null;
  threadRootId: string | null;
  mentionsLumo: boolean;
  mentionedUserIds: string[];
  isMentioned: boolean;
  isMine: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceTeamAgentHistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  authorName: string;
  content: string;
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

  async listTeamMessages(
    workspaceId: string,
    userId: string,
    limit = 200,
  ): Promise<WorkspaceTeamMessage[]> {
    await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const rows = await this.teamMessageQuery(userId)
      .where('message.workspaceId', workspaceId)
      .orderBy('message.createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 500));
    return (rows as WorkspaceTeamMessage[]).reverse();
  }

  async createTeamMessage(
    workspaceId: string,
    userId: string,
    input: {
      body: string;
      replyToMessageId?: string;
      mentionedUserIds?: string[];
    },
  ): Promise<WorkspaceTeamMessage> {
    const access = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to post in Team Chat');
    }

    const mentionedUserIds = Array.from(new Set(input.mentionedUserIds || []));
    for (const mentionedUserId of mentionedUserIds) {
      await this.ensureMentionTargetHasAccess(workspaceId, mentionedUserId);
    }

    let replyTo: WorkspaceTeamMessage | null = null;
    if (input.replyToMessageId) {
      replyTo = await this.getTeamMessage(workspaceId, input.replyToMessageId, userId);
    }

    const id = uuidv4();
    const body = input.body.trim();
    await this.db.transaction(async (tx) => {
      await tx('workspace_team_messages').insert({
        id,
        workspaceId,
        originVersionId: access.currentPublishedVersionId,
        authorId: userId,
        authorType: 'user',
        body,
        replyToMessageId: replyTo?.id || null,
        threadRootId: replyTo ? (replyTo.threadRootId || replyTo.id) : null,
        mentionsLumo: /(^|\s)@lumo\b/i.test(body),
      });
      if (mentionedUserIds.length) {
        await tx('workspace_team_message_mentions').insert(
          mentionedUserIds.map((mentionedUserId) => ({
            messageId: id,
            userId: mentionedUserId,
          })),
        );
      }
    });

    return this.getTeamMessage(workspaceId, id, userId);
  }

  async getLumoRequestMessage(
    workspaceId: string,
    messageId: string,
    userId: string,
  ): Promise<WorkspaceTeamMessage> {
    const access = await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to invoke Lumo in Team Chat');
    }
    const message = await this.getTeamMessage(workspaceId, messageId, userId);
    if (message.authorType !== 'user' || message.authorId !== userId) {
      throw new AccessDeniedError('Lumo can only be invoked from your own Team Chat message');
    }
    if (!message.mentionsLumo) {
      throw new ConflictError('Tag @Lumo in the message to request a response');
    }
    return message;
  }

  async findLumoReply(
    workspaceId: string,
    sourceMessageId: string,
    userId: string,
  ): Promise<WorkspaceTeamMessage | null> {
    await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const existing = await this.teamMessageQuery(userId)
      .where('message.workspaceId', workspaceId)
      .andWhere('message.replyToMessageId', sourceMessageId)
      .andWhere('message.authorType', 'lumo')
      .first();
    return (existing as WorkspaceTeamMessage | undefined) || null;
  }

  async appendLumoReply(
    workspaceId: string,
    sourceMessage: WorkspaceTeamMessage,
    invokingUserId: string,
    body: string,
  ): Promise<WorkspaceTeamMessage> {
    const existing = await this.findLumoReply(workspaceId, sourceMessage.id, invokingUserId);
    if (existing) {
      return existing;
    }
    const id = uuidv4();
    try {
      await this.db('workspace_team_messages').insert({
        id,
        workspaceId,
        originVersionId: sourceMessage.originVersionId,
        authorId: null,
        authorType: 'lumo',
        body: body.trim(),
        replyToMessageId: sourceMessage.id,
        threadRootId: sourceMessage.threadRootId || sourceMessage.id,
        mentionsLumo: false,
        metadata: {
          readOnly: true,
          invokedByUserId: invokingUserId,
          sourceMessageId: sourceMessage.id,
        },
      });
    } catch (error: any) {
      if (error?.code !== '23505') {
        throw error;
      }
      const duplicate = await this.findLumoReply(workspaceId, sourceMessage.id, invokingUserId);
      if (duplicate) return duplicate;
      throw error;
    }
    return this.getTeamMessage(workspaceId, id, invokingUserId);
  }

  async listTeamAgentHistory(
    workspaceId: string,
    userId: string,
    excludeMessageId?: string,
    limit = 20,
  ): Promise<WorkspaceTeamAgentHistoryMessage[]> {
    await this.ensurePublishedWorkspaceAccess(workspaceId, userId);
    const rows = await this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.workspaceId', workspaceId)
      .modify((query) => {
        if (excludeMessageId) query.whereNot('message.id', excludeMessageId);
      })
      .whereIn('message.authorType', ['user', 'lumo'])
      .select(
        'message.id',
        'message.authorType',
        'message.body',
        this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`),
      )
      .orderBy('message.createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 50));

    return rows.reverse().map((row: any) => ({
      id: row.id,
      role: row.authorType === 'lumo' ? 'assistant' : 'user',
      authorName: row.authorType === 'lumo' ? 'Lumo' : row.authorName,
      content: row.body,
    }));
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
    if (input.sourceTeamMessageId) {
      await this.getTeamMessage(workspaceId, input.sourceTeamMessageId, userId);
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
        sourceTeamMessageId: input.sourceTeamMessageId || null,
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
    return {
      membership,
      currentPublishedVersionId: workspace.currentPublishedVersionId || null,
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

  private teamMessageQuery(userId: string) {
    return this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .leftJoin('workspace_published_versions as version', 'version.id', 'message.originVersionId')
      .select(
        'message.*',
        'version.versionNumber as originVersionNumber',
        this.db.raw(`
          CASE
            WHEN message."authorType" = 'lumo' THEN 'Lumo'
            WHEN message."authorType" = 'system' THEN 'HelpUdoc'
            ELSE COALESCE(author."displayName", 'Former user')
          END as "authorName"
        `),
        this.db.raw(`ARRAY(
          SELECT mention."userId"::text
          FROM workspace_team_message_mentions mention
          WHERE mention."messageId" = message.id
          ORDER BY mention."createdAt" ASC
        ) as "mentionedUserIds"`),
        this.db.raw(`EXISTS(
          SELECT 1
          FROM workspace_team_message_mentions mention
          WHERE mention."messageId" = message.id
            AND mention."userId" = ?
        ) as "isMentioned"`, [userId]),
      this.db.raw(`COALESCE(message."authorId" = ?, false) as "isMine"`, [userId]),
      );
  }

  private async getTeamMessage(
    workspaceId: string,
    messageId: string,
    userId: string,
  ): Promise<WorkspaceTeamMessage> {
    const message = await this.teamMessageQuery(userId)
      .where('message.workspaceId', workspaceId)
      .andWhere('message.id', messageId)
      .first() as WorkspaceTeamMessage | undefined;
    if (!message) {
      throw new NotFoundError('Team Chat message not found');
    }
    return message;
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
