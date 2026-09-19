import { createNotification } from './notificationService';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

import { AccessDeniedError, ConflictError, HttpError, NotFoundError } from '../errors';
import { DatabaseService } from './databaseService';
import { WorkspacePublicationService } from './workspacePublicationService';
import { WorkspaceMembershipRecord, WorkspaceService } from './workspaceService';
import type { FileService } from './fileService';
import { WorkspaceTeamThreadStore, deriveThreadTitle, type ThreadStatus } from './workspaceTeamThreadStore';
import type { TeamThreadChangeRecord, ProposalChangeSet, TeamThreadReadiness } from '@helpudoc/contracts/types';
import {
  canCreateWorkspaceCollaborationObject,
  canModerateWorkspaceCollaboration,
  canPostWorkspaceTeamMessage,
  getWorkspaceRoleCapabilities,
  type WorkspaceCollaborationObjectType,
  type WorkspaceCollaborationVisibility,
} from './workspaceCollaborationPolicy';
import {
  TEAM_CONTEXT_CHAR_BUDGET,
  TEAM_CONTEXT_BUILDER_VERSION,
  TEAM_CONTEXT_HISTORY_PAGE,
  TEAM_PROMPT_SCAFFOLD_CHARS,
  TRUNCATION_NOTICE_CHARS,
  QUOTE_NOTICE_CHARS,
  HISTORY_MESSAGE_OVERHEAD_CHARS,
  referenceOverheadChars,
} from './workspaceTeamContextBudget';

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
  sourceThreadId: string | null;
  anchorVersionId: string | null;
  submittedChangeSetId: string | null;
  submissionRevision: number | null;
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
  /** F8: explicit thread link (workspace-audience objects only). */
  sourceThreadId?: string;
  /** F8: immutable file version that contained the anchor at creation. */
  anchorVersionId?: string;
};

export type UpdateWorkspaceCollaborationInput = {
  status?: WorkspaceCollaborationStatus;
  assigneeId?: string | null;
  dueAt?: string | null;
  /** F8: explicit link/unlink to a thread (null unlinks). */
  sourceThreadId?: string | null;
};

type CollaborationAccess = {
  membership: WorkspaceMembershipRecord;
  currentPublishedVersionId: string | null;
  isShared: boolean;
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
  /**
   * When the original message could not fit the input budget in full, `content`
   * holds a truncated excerpt and this metadata records how to retrieve the
   * exact original through the authenticated thread-history reader (spec F3.4).
   */
  excerpt?: {
    sequence: number;
    originalLength: number;
    includedLength: number;
    truncated: true;
  };
};

/**
 * Recorded excerpt entry persisted in the context manifest so retries reproduce
 * the exact same excerpting decision and the agent can fetch the untruncated
 * original by sequence through the authenticated reader.
 */
export type WorkspaceTeamContextExcerpt = {
  messageId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'source';
  originalLength: number;
  includedLength: number;
};

export type TeamThreadSummaryRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: ThreadStatus;
  rootMessageId: string | null;
  rootPreview: string;
  createdBy: string | null;
  replyCount: number;
  lastActivityAt: string;
  lastMessageSeq: number;
  participants: Array<{ userId: string; displayName: string }>;
  unread: boolean;
  unreadCount: number;
  following: boolean;
  runStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadMessagePage = {
  thread: TeamThreadSummaryRow;
  messages: WorkspaceTeamMessage[];
  olderCursor: string | null;
  newerCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
};

const THREAD_LIST_DEFAULT_LIMIT = 30;
const THREAD_LIST_MAX_LIMIT = 100;
const THREAD_MESSAGE_DEFAULT_LIMIT = 50;
const THREAD_MESSAGE_MAX_LIMIT = 100;

/** Opaque cursor scoped to workspace/filter. */
const encodeCursor = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decodeCursor = (cursor: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
};

export class WorkspaceCollaborationService {
  private readonly db: Knex;
  private readonly workspaceService: WorkspaceService;
  private readonly publicationService: WorkspacePublicationService;
  private readonly fileService: FileService | null;
  private readonly threads: WorkspaceTeamThreadStore;

  constructor(
    databaseService: DatabaseService,
    workspaceService: WorkspaceService,
    publicationService: WorkspacePublicationService,
    fileService?: FileService,
  ) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.publicationService = publicationService;
    this.fileService = fileService || null;
    this.threads = new WorkspaceTeamThreadStore(this.db);
  }

  private requireFileService(): FileService {
    if (!this.fileService) {
      throw new HttpError(500, 'File service is not configured for immutable byte access');
    }
    return this.fileService;
  }

  async withTeamMessageLock<T>(workspaceId: string, messageId: string, work: (row: WorkspaceTeamMessage, tx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const row = await tx('workspace_team_messages').where({ workspaceId, id: messageId }).forUpdate().first();
      if (!row) throw new NotFoundError('Workspace Chat message not found');
      return work(row, tx);
    });
  }

  async updateTeamRun(workspaceId: string, messageId: string, metadata: Record<string, unknown>) {
    await this.withTeamMessageLock(workspaceId, messageId, async (row, tx) => {
      await tx('workspace_team_messages').where({ id: messageId }).update({
        metadata: { ...row.metadata, ...metadata }, updatedAt: new Date(),
      });
    });
  }

  async listTeamMessages(
    workspaceId: string,
    userId: string,
    limit = 200,
    includeMessageId?: string,
  ): Promise<WorkspaceTeamMessage[]> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const rows = await this.teamMessageQuery(userId)
      .where('message.workspaceId', workspaceId)
      .orderBy('message.createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 500));
    const messages = (rows as WorkspaceTeamMessage[]).reverse();
    // Preserve the exact destination of an older mention without exposing another workspace.
    if (includeMessageId) {
      const target = await this.getTeamMessage(workspaceId, includeMessageId, userId);
      if (!messages.some((message) => message.id === target.id)) messages.push(target);
      if (target.threadRootId && !messages.some((message) => message.id === target.threadRootId)) {
        messages.push(await this.getTeamMessage(workspaceId, target.threadRootId, userId));
      }
      messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return messages;
  }

  async listPendingTeamMessages(workspaceId: string, userId: string): Promise<WorkspaceTeamMessage[]> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    return this.teamMessageQuery(userId)
      .where('message.workspaceId', workspaceId)
      .whereRaw(`message.metadata->>'runStatus' IN ('queued', 'running', 'awaiting_approval')`)
      .orderBy('message.updatedAt', 'asc')
      .limit(100);
  }

  async createTeamMessage(
    workspaceId: string,
    userId: string,
    input: {
      body: string;
      replyToMessageId?: string;
      mentionedUserIds?: string[];
      references?: Array<Record<string, unknown>>;
    },
  ): Promise<WorkspaceTeamMessage> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to post in Workspace Chat');
    }

    const mentionedUserIds = Array.from(new Set(input.mentionedUserIds || []));
    for (const mentionedUserId of mentionedUserIds) {
      await this.ensureMentionTargetHasAccess(workspaceId, mentionedUserId);
    }

    let replyTo: WorkspaceTeamMessage | null = null;
    if (input.replyToMessageId) {
      replyTo = await this.getTeamMessage(workspaceId, input.replyToMessageId, userId);
    }

    const { collaborators } = await this.workspaceService.listCollaborators(workspaceId, userId);
    const body = input.body.trim();
    const mentionsLumo = this.detectLumoRequest(body, input.references);
    const metadata = { references: input.references || [], ...(mentionsLumo ? { runStatus: 'queued' } : {}) };

    // Dual write: a legacy root send creates a thread; a legacy reply resolves
    // (and lazily migrates) its target's canonical thread, then appends.
    let id: string;
    if (replyTo) {
      const legacyRoot = replyTo.id;
      id = await this.db.transaction(async (tx) => {
        const threadId = (replyTo as any).threadId
          || await this.threads.ensureThreadForLegacyRoot(tx, workspaceId, legacyRoot);
        const inserted = await this.threads.appendMessage(tx, {
          workspaceId, threadId, authorId: userId, authorType: 'user', body,
          originVersionId: access.currentPublishedVersionId,
          replyToMessageId: replyTo!.id, mentionsLumo, metadata,
        });
        if (mentionedUserIds.length) {
          await tx('workspace_team_message_mentions').insert(
            mentionedUserIds.map((mentionedUserId) => ({ messageId: inserted.id, userId: mentionedUserId })),
          );
        }
        await tx('workspace_team_thread_user_state')
          .insert({ threadId, userId, lastReadSeq: inserted.sequence, following: true })
          .onConflict(['threadId', 'userId']).merge({ following: true, updatedAt: tx.fn.now() });
        if (mentionsLumo) {
          await this.reserveThreadRunSlot(tx, {
            workspaceId, threadId, sourceMessageId: inserted.id, requestedBy: userId,
            contextCutoffSeq: inserted.sequence, contextManifest: {}, policySnapshot: {}, contextBuilderVersion: 'thread-ctx-v1',
          });
        }
        for (const recipientUserId of new Set([...collaborators.map((member) => member.userId), ...mentionedUserIds].filter((rid) => rid !== userId))) {
          const mentioned = mentionedUserIds.includes(recipientUserId);
          await createNotification(tx, {
            recipientUserId,
            eventType: mentioned ? 'chat.mentioned' : 'chat.message',
            resourceType: 'workspace_team_message', resourceId: inserted.id, eventKey: inserted.id,
            payload: { title: mentioned ? 'You were mentioned in team chat' : 'New team chat message', description: body.slice(0, 500), workspaceId, messageId: inserted.id, threadId, channel: 'team' },
          });
        }
        return inserted.id;
      });
    } else {
      id = await this.db.transaction(async (tx) => {
        const { thread, message } = await this.threads.createThreadWithRoot(tx, {
          workspaceId, authorId: userId, body, originVersionId: access.currentPublishedVersionId,
          mentionsLumo, metadata,
        });
        if (mentionedUserIds.length) {
          await tx('workspace_team_message_mentions').insert(
            mentionedUserIds.map((mentionedUserId) => ({ messageId: message.id, userId: mentionedUserId })),
          );
        }
        await tx('workspace_team_thread_user_state')
          .insert({ threadId: thread.id, userId, lastReadSeq: 1, following: true })
          .onConflict(['threadId', 'userId']).merge({ following: true, lastReadSeq: 1, updatedAt: tx.fn.now() });
        if (mentionsLumo) {
          await this.reserveThreadRunSlot(tx, {
            workspaceId, threadId: thread.id, sourceMessageId: message.id, requestedBy: userId,
            contextCutoffSeq: message.sequence, contextManifest: {}, policySnapshot: {}, contextBuilderVersion: 'thread-ctx-v1',
          });
        }
        for (const recipientUserId of new Set([...collaborators.map((member) => member.userId), ...mentionedUserIds].filter((rid) => rid !== userId))) {
          const mentioned = mentionedUserIds.includes(recipientUserId);
          await createNotification(tx, {
            recipientUserId,
            eventType: mentioned ? 'chat.mentioned' : 'chat.message',
            resourceType: 'workspace_team_message', resourceId: message.id, eventKey: message.id,
            payload: { title: mentioned ? 'You were mentioned in team chat' : 'New team chat message', description: body.slice(0, 500), workspaceId, messageId: message.id, threadId: thread.id, channel: 'team' },
          });
        }
        return message.id;
      });
    }

    return this.getTeamMessage(workspaceId, id, userId);
  }

  async getLumoRequestMessage(
    workspaceId: string,
    messageId: string,
    userId: string,
  ): Promise<WorkspaceTeamMessage> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to invoke Lumo in Workspace Chat');
    }
    const message = await this.getTeamMessage(workspaceId, messageId, userId);
    if (message.authorType !== 'user' || message.authorId !== userId) {
      throw new AccessDeniedError('Lumo can only be invoked from your own Workspace Chat message');
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
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
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
    metadata: Record<string, unknown> = {},
  ): Promise<WorkspaceTeamMessage> {
    const existing = await this.findLumoReply(workspaceId, sourceMessage.id, invokingUserId);
    if (existing) {
      return existing;
    }
    const sourceThreadId = (sourceMessage as any).threadId as string | null;
    let id: string;
    try {
      id = await this.db.transaction(async (tx) => {
        // Resolve (and lazily migrate) the owning thread so the Lumo reply is
        // appended with a canonical, monotonic sequence.
        const threadId = sourceThreadId
          || await this.threads.ensureThreadForLegacyRoot(tx, workspaceId, sourceMessage.id);
        const inserted = await this.threads.appendMessage(tx, {
          workspaceId, threadId, authorId: null, authorType: 'lumo', body: body.trim(),
          originVersionId: sourceMessage.originVersionId,
          replyToMessageId: sourceMessage.id,
          mentionsLumo: false,
          metadata: { ...metadata, invokedByUserId: invokingUserId, sourceMessageId: sourceMessage.id },
        });
        return inserted.id;
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

  /**
   * Thread-scoped conversation history for the agent (spec F3). Never returns
   * workspace-wide chat. Excludes the source message, any message at or after
   * the cutoff sequence, and pending/partial agent output.
   */
  async listTeamAgentHistory(
    workspaceId: string,
    userId: string,
    scope: { threadId: string; cutoffSeq: number; excludeMessageId?: string },
    limit = 20,
  ): Promise<WorkspaceTeamAgentHistoryMessage[]> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const rows = await this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.workspaceId', workspaceId)
      .andWhere('message.threadId', scope.threadId)
      .andWhere('message.sequence', '<', scope.cutoffSeq)
      .modify((query) => {
        if (scope.excludeMessageId) query.whereNot('message.id', scope.excludeMessageId);
      })
      .whereIn('message.authorType', ['user', 'lumo'])
      // Exclude pending/partial agent output and operational status events.
      .whereRaw(`COALESCE(message.metadata->>'runStatus', 'completed') NOT IN ('queued', 'running', 'awaiting_approval', 'awaiting_input')`)
      .select(
        'message.id',
        'message.sequence',
        'message.authorType',
        'message.body',
        this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`),
      )
      .orderBy('message.sequence', 'desc')
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
    const access = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);

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
        if (!access.isShared) query.where('object.type', 'annotation').where('object.visibility', 'private');
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

    return (rows as WorkspaceCollaborationObject[]).map((object) => this.redactObjectForViewer(object, userId));
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
    const access = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId, !access.isShared);
    const messages = await this.db('workspace_collaboration_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.objectId', objectId)
      .select(
        'message.*',
        this.db.raw(`COALESCE(author."displayName", 'Former user') as "authorName"`),
      )
      .orderBy('message.createdAt', 'asc');
    return { object: this.redactObjectForViewer(object, userId), messages };
  }

  async createObject(
    workspaceId: string,
    userId: string,
    input: CreateWorkspaceCollaborationInput,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);
    if (!access.isShared && (input.type !== 'annotation' || input.visibility !== 'private' || input.sourceTeamMessageId)) {
      throw new ConflictError('Personal workspaces support private annotations only');
    }
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
    // F8: explicit thread link. A workspace-audience object may link to a thread
    // in the SAME workspace. A PRIVATE annotation must NOT carry a thread link —
    // exposing a private annotation to a team thread requires explicit conversion
    // to shared content first (spec F8: "A private annotation requires explicit
    // conversion/sharing of selected content before a team link can expose it").
    let linkedThreadId: string | null = null;
    if (input.sourceThreadId) {
      if (input.visibility !== 'workspace_audience') {
        throw new ConflictError('A private annotation must be shared before linking it to a thread', { code: 'ANNOTATION_PRIVATE' });
      }
      const thread = await this.db('workspace_team_threads').where({ id: input.sourceThreadId, workspaceId }).first();
      if (!thread) throw new NotFoundError('Thread not found');
      linkedThreadId = String(thread.id);
    }
    // F8: immutable anchor version. If supplied, it must be a version of THIS
    // object's file in THIS workspace. Otherwise, when a file anchor is present,
    // default to the file's current version so the anchor is pinned to an
    // immutable snapshot (spec F8: "Record the version containing the anchor").
    const anchor = await this.resolveAnchorVersionForCreate(workspaceId, input);

    const recipients = input.type === 'annotation' && input.visibility === 'workspace_audience'
      ? (await this.workspaceService.listCollaborators(workspaceId, userId)).collaborators.map(member => member.userId)
      : [];
    const id = uuidv4();
    await this.db.transaction(async (tx) => {
      await tx('workspace_collaboration_objects').insert({
        id,
        workspaceId,
        originVersionId: access.currentPublishedVersionId,
        type: input.type,
        visibility: input.visibility,
        status: input.type === 'change_proposal' ? 'proposed' : 'open',
        fileId: anchor.fileId ?? input.fileId ?? null,
        filePath: this.optionalText(input.filePath),
        blockId: this.optionalText(input.blockId),
        anchorText: input.anchorText || null,
        anchorStart: input.anchorStart ?? null,
        anchorEnd: input.anchorEnd ?? null,
        anchorFingerprint: this.optionalText(input.anchorFingerprint),
        title: this.optionalText(input.title),
        body: input.body.trim(),
        authorId: userId,
        assigneeId: input.assigneeId || null,
        sourceTeamMessageId: input.sourceTeamMessageId || null,
        sourceThreadId: linkedThreadId,
        anchorVersionId: anchor.anchorVersionId,
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
      for (const recipientUserId of new Set(recipients.filter(id => id !== userId))) {
        await createNotification(tx, {
          recipientUserId, eventType: 'annotation.created', resourceType: 'workspace_annotation', resourceId: id, eventKey: id,
          payload: { title: 'New canvas comment', description: input.body.trim().slice(0, 500), workspaceId, annotationId: id, filePath: input.filePath },
        });
      }
    });

    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, id, userId), userId);
  }

  async appendMessage(
    workspaceId: string,
    objectId: string,
    userId: string,
    body: string,
  ) {
    const { membership, isShared } = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId, !isShared);
    if (
      object.visibility === 'workspace_audience'
      && !getWorkspaceRoleCapabilities(membership.role).canComment
    ) {
      throw new AccessDeniedError('Commenter access is required to reply');
    }

    const recipients = object.type === 'annotation' && object.visibility === 'workspace_audience'
      ? (await this.workspaceService.listCollaborators(workspaceId, userId)).collaborators.map(member => member.userId)
      : [];
    const message = await this.db.transaction(async tx => {
      const [created] = await tx('workspace_collaboration_messages').insert({
        id: uuidv4(), objectId, authorId: userId, body: body.trim(),
      }).returning('*');
      await tx('workspace_collaboration_objects').where({ id: objectId }).update({
        status: object.status === 'open' ? 'discussing' : object.status, updatedAt: tx.fn.now(),
      });
      for (const recipientUserId of new Set(recipients.filter(id => id !== userId))) {
        await createNotification(tx, {
          recipientUserId, eventType: 'annotation.replied', resourceType: 'workspace_annotation', resourceId: objectId, eventKey: created.id,
          payload: { title: 'New reply to a canvas comment', description: body.trim().slice(0, 500), workspaceId, annotationId: objectId, filePath: object.filePath },
        });
      }
      return created;
    });
    return message;
  }

  async updateObject(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: UpdateWorkspaceCollaborationInput,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId, !access.isShared);
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
    // F8: explicit thread link/unlink. Only workspace-audience objects may be
    // linked; a private annotation must be shared first. null unlinks.
    let threadLinkPatch: Record<string, unknown> = {};
    if (input.sourceThreadId !== undefined) {
      if (input.sourceThreadId === null) {
        threadLinkPatch = { sourceThreadId: null };
      } else {
        if (object.visibility !== 'workspace_audience') {
          throw new ConflictError('A private annotation must be shared before linking it to a thread', { code: 'ANNOTATION_PRIVATE' });
        }
        const thread = await this.db('workspace_team_threads').where({ id: input.sourceThreadId, workspaceId }).first();
        if (!thread) throw new NotFoundError('Thread not found');
        threadLinkPatch = { sourceThreadId: String(thread.id) };
      }
    }

    const resolved = input.status === 'resolved' || input.status === 'addressed';
    await this.db('workspace_collaboration_objects')
      .where({ id: objectId })
      .update({
        ...(input.status ? { status: input.status } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...threadLinkPatch,
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

    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, objectId, userId), userId);
  }

  async convertToProposal(
    workspaceId: string,
    objectId: string,
    userId: string,
    options: { sourceThreadId?: string | null } = {},
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!getWorkspaceRoleCapabilities(access.membership.role).canPropose) {
      throw new AccessDeniedError('Contributor access is required to create a proposal');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.visibility !== 'workspace_audience') {
      throw new ConflictError('Make the item visible to the workspace before converting it to a proposal');
    }
    // Prevent ownership transfer: if this object is ALREADY a proposal linked to a
    // private copy owned by someone else, a different contributor must not replace
    // that link (which would hijack the submission/apply ownership). They can open
    // their own separate proposal instead.
    if (object.linkedPrivateWorkspaceId) {
      const existingPriv = await this.db('workspaces').where({ id: object.linkedPrivateWorkspaceId }).first();
      if (existingPriv && String(existingPriv.ownerId) !== String(userId)) {
        throw new HttpError(403, 'This proposal is already linked to another member\'s private working copy', { code: 'PROPOSAL_OWNED_BY_OTHER' });
      }
    }
    // Explicit origin thread (spec F7): record which thread this "Work privately"
    // proposal originated from. This is author-only metadata on the shared object;
    // it grants nobody else access to the private copy and never auto-shares any
    // private change. Validated to the SAME workspace.
    let originThreadId: string | null = (object as any).sourceThreadId || null;
    if (options.sourceThreadId !== undefined) {
      if (options.sourceThreadId === null) {
        originThreadId = null;
      } else {
        const thread = await this.db('workspace_team_threads').where({ id: options.sourceThreadId, workspaceId }).first();
        if (!thread) throw new NotFoundError('Thread not found');
        originThreadId = String(thread.id);
      }
    }

    const privateWorkspace = await this.publicationService.createPrivateCopy(workspaceId, userId);
    await this.db('workspace_collaboration_objects')
      .where({ id: objectId })
      .update({
        type: 'change_proposal',
        status: 'proposed',
        linkedPrivateWorkspaceId: privateWorkspace.id,
        sourceThreadId: originThreadId,
        updatedAt: this.db.fn.now(),
      });
    // Record the origin thread on the PRIVATE activity (author-private). A reused
    // private copy accumulates multiple origin threads without overwriting a
    // single one; this grants nobody else access to the private copy.
    if (originThreadId) {
      await this.db('workspace_private_copy_origins')
        .insert({
          id: uuidv4(),
          privateWorkspaceId: privateWorkspace.id,
          sharedWorkspaceId: workspaceId,
          sourceThreadId: originThreadId,
          objectId,
          userId,
        })
        .onConflict(['privateWorkspaceId', 'sourceThreadId'])
        .ignore();
    }
    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, objectId, userId), userId);
  }

  async applyProposal(
    workspaceId: string,
    objectId: string,
    userId: string,
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canModerateWorkspaceCollaboration(access.membership.role)) {
      throw new AccessDeniedError('Owner or Publisher access is required to apply a proposal');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.type !== 'change_proposal' || !object.linkedPrivateWorkspaceId) {
      throw new ConflictError('This collaboration item does not have a linked change proposal');
    }
    // Thread-linked proposals and any proposal that has a frozen submission must
    // go through the submission apply path; the legacy whole-private-copy apply
    // must not bypass the explicit frozen selection.
    if ((object as any).sourceThreadId || (object as any).submittedChangeSetId) {
      throw new ConflictError('This proposal requires an explicit submitted change set; apply the submission instead', { code: 'SUBMISSION_REQUIRED' });
    }
    if (object.status !== 'proposed' && object.status !== 'discussing') {
      throw new ConflictError('Only an open proposal can be applied');
    }

    const applied = await this.publicationService.applyPrivateCopyToShared(
      object.linkedPrivateWorkspaceId,
      workspaceId,
      userId,
    );
    await this.db('workspace_collaboration_objects').where({ id: objectId }).update({
      status: 'addressed',
      resolvedAt: this.db.fn.now(),
      resolvedByVersionId: null,
      updatedAt: this.db.fn.now(),
    });
    await this.db('workspace_collaboration_messages').insert({
      id: uuidv4(),
      objectId,
      authorId: userId,
      body: `Applied to working revision ${applied.contentRevision}.`,
    });
    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, objectId, userId), userId);
  }

  // --- Team Chat threads (Release A) -------------------------------------

  private detectLumoRequest(body: string, references?: Array<Record<string, unknown>>): boolean {
    return /(^|\s)@lumo\b/i.test(body)
      || Boolean(references?.some((ref) => ref.kind === 'skill' || ref.kind === 'agent'));
  }

  /**
   * Normalized idempotency fingerprint over the semantic payload (destination,
   * body, quote, references, mentions, title). A reused client id with any of
   * these changed must be rejected, not silently deduped.
   */
  private payloadFingerprint(payload: {
    destination: string;
    body: string;
    title?: string;
    replyToMessageId?: string;
    references?: Array<Record<string, unknown>>;
    mentionedUserIds?: string[];
  }): string {
    const canonical = JSON.stringify({
      destination: payload.destination,
      body: payload.body.trim(),
      title: (payload.title || '').trim(),
      replyToMessageId: payload.replyToMessageId || null,
      references: (payload.references || []).map((r) => ({ kind: r.kind, id: r.id, version: r.version ?? null, publishedVersionId: r.publishedVersionId ?? null })),
      mentionedUserIds: [...(payload.mentionedUserIds || [])].sort(),
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private threadSummarySelect(userId: string) {
    return this.db('workspace_team_threads as thread')
      .leftJoin('workspace_team_messages as root', 'root.id', 'thread.rootMessageId')
      .leftJoin('workspace_team_thread_user_state as state', (join) => {
        join.on('state.threadId', 'thread.id').andOn('state.userId', this.db.raw('?', [userId]));
      })
      .leftJoin('workspace_team_thread_runs as run', (join) => {
        join.on('run.threadId', 'thread.id')
          .andOnIn('run.status', ['queued', 'running', 'awaiting_input']);
      })
      .select(
        'thread.*',
        this.db.raw(`COALESCE(LEFT(root.body, 280), '') as "rootPreview"`),
        this.db.raw(`COALESCE(state."lastReadSeq", 0) as "lastReadSeq"`),
        this.db.raw(`COALESCE(state.following, false) as "following"`),
        this.db.raw(`run.status as "runStatus"`),
      );
  }

  private async hydrateThreadSummaries(rows: any[]): Promise<TeamThreadSummaryRow[]> {
    if (!rows.length) return [];
    const threadIds = rows.map((row) => row.id);
    // Participants and reply counts in one grouped query each — no per-item N+1.
    const participantRows = await this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .whereIn('message.threadId', threadIds)
      .whereNotNull('message.authorId')
      .distinct('message.threadId', 'message.authorId')
      .select(this.db.raw(`COALESCE(author."displayName", 'Former user') as "displayName"`));
    const byThread = new Map<string, Array<{ userId: string; displayName: string }>>();
    for (const p of participantRows) {
      const list = byThread.get(p.threadId) || [];
      list.push({ userId: p.authorId, displayName: p.displayName });
      byThread.set(p.threadId, list);
    }
    return rows.map((row) => {
      const lastSeq = Number(row.lastMessageSeq || 0);
      const lastRead = Number(row.lastReadSeq || 0);
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title || 'Untitled thread',
        status: row.status,
        rootMessageId: row.rootMessageId,
        rootPreview: (row.rootPreview || '').replace(/\s+/g, ' ').trim(),
        createdBy: row.createdBy,
        replyCount: Math.max(lastSeq - 1, 0),
        lastActivityAt: row.lastActivityAt,
        lastMessageSeq: lastSeq,
        participants: byThread.get(row.id) || [],
        unread: lastSeq > lastRead,
        unreadCount: Math.max(lastSeq - lastRead, 0),
        following: Boolean(row.following),
        runStatus: row.runStatus || null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async listThreads(
    workspaceId: string,
    userId: string,
    filters: { status?: 'open' | 'resolved' | 'all'; cursor?: string; limit?: number } = {},
  ): Promise<{ threads: TeamThreadSummaryRow[]; nextCursor: string | null }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const limit = Math.min(Math.max(filters.limit || THREAD_LIST_DEFAULT_LIMIT, 1), THREAD_LIST_MAX_LIMIT);
    const status = filters.status || 'all';
    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    // Validate the cursor is scoped to this workspace/filter.
    if (cursor) {
      if (cursor.workspaceId !== workspaceId || cursor.status !== status || typeof cursor.snapshotAt !== 'string') {
        throw new HttpError(400, 'Cursor does not match this list');
      }
    }
    // A fixed snapshot moment. Ordering is derived from each thread's activity AS
    // OF this moment (the latest message created at/before it), NOT the mutable
    // lastActivityAt column, so a thread cannot jump the cursor or vanish when a
    // new message advances its live activity above the original cutoff.
    // Use the DATABASE clock for the snapshot moment to avoid client/DB clock
    // skew (which could otherwise exclude just-created threads whose createdAt
    // was written with the DB's now()).
    let snapshotAt = cursor?.snapshotAt as string | undefined;
    if (!snapshotAt) {
      const nowRow = await this.db.raw('SELECT now() as now');
      const now = nowRow.rows[0].now;
      snapshotAt = now instanceof Date ? now.toISOString() : String(now);
    }
    // Correlated subquery: the thread's activity AS OF the snapshot moment.
    // Render timestamps as TEXT with full microsecond precision so the cursor is
    // not truncated to milliseconds by the driver's Date conversion (node-pg maps
    // timestamptz -> JS Date, which only keeps millisecond precision — that
    // truncation drops rows tied at sub-millisecond timestamps across pages).
    const ACTIVITY_SQL = `(SELECT MAX(m."createdAt") FROM workspace_team_messages m WHERE m."threadId" = thread.id AND m."createdAt" <= ?::timestamptz)`;
    // Render the wall-clock TEXT explicitly AT TIME ZONE 'UTC'. to_char() on a
    // timestamptz formats in the session timezone; appending a literal "Z" while
    // the session is e.g. Asia/Kuala_Lumpur (+08:00) produces a value labeled UTC
    // but carrying local wall-clock time. Casting that mislabeled string back with
    // ?::timestamptz then shifts the comparison boundary by the offset, so the
    // keyset predicate no longer excludes the cursor row and pages repeat/drop
    // rows. Forcing UTC makes the "Z" label truthful and the round-trip exact
    // under any DATABASE session timezone.
    const ACTIVITY_TEXT_SQL = `(SELECT to_char(MAX(m."createdAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM workspace_team_messages m WHERE m."threadId" = thread.id AND m."createdAt" <= ?::timestamptz)`;
    const EXISTS_SQL = `EXISTS (SELECT 1 FROM workspace_team_messages m WHERE m."threadId" = thread.id AND m."createdAt" <= ?::timestamptz)`;

    const query = this.threadSummarySelect(userId)
      .where('thread.workspaceId', workspaceId)
      .select(this.db.raw(`${ACTIVITY_TEXT_SQL} as "snapshotActivityAt"`, [snapshotAt]))
      // Only threads that existed (had a message) as of the snapshot.
      .whereRaw(EXISTS_SQL, [snapshotAt])
      .modify((builder) => {
        if (status !== 'all') builder.where('thread.status', status);
        if (cursor?.activityAt && cursor?.id) {
          // Compare as full-precision timestamptz + id, matching the ORDER BY.
          builder.whereRaw(`(${ACTIVITY_SQL}, thread.id) < (?::timestamptz, ?)`, [snapshotAt, cursor.activityAt as string, cursor.id as string]);
        }
      })
      .orderByRaw(`${ACTIVITY_SQL} DESC, thread.id DESC`, [snapshotAt])
      .limit(limit + 1);

    const rows = await query;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = hasMore
      ? encodeCursor({ workspaceId, status, snapshotAt, activityAt: page[page.length - 1].snapshotActivityAt, id: page[page.length - 1].id })
      : null;
    return { threads: await this.hydrateThreadSummaries(page), nextCursor };
  }

  /**
   * Look up a prior human send by (workspace, author, clientMessageId). If found,
   * enforce that the semantic payload fingerprint matches; a reused key with a
   * changed payload or destination is a 409 IDEMPOTENCY_KEY_REUSED. Returns the
   * existing message row on an exact-duplicate retry, or null when unused.
   */
  private async resolveIdempotent(
    workspaceId: string,
    userId: string,
    clientMessageId: string | undefined,
    fingerprint: string,
    expectedThreadId?: string,
  ): Promise<any | null> {
    if (!clientMessageId) return null;
    const existing = await this.db('workspace_team_messages')
      .where({ workspaceId, authorId: userId, clientMessageId, authorType: 'user' })
      .first();
    if (!existing) return null;
    if (String(existing.clientPayloadHash || '') !== fingerprint
      || (expectedThreadId && existing.threadId !== expectedThreadId)) {
      throw new ConflictError('This client message id was already used with a different payload or destination', { code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    return existing;
  }

  async getThread(workspaceId: string, threadId: string, userId: string): Promise<TeamThreadSummaryRow> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const row = await this.threadSummarySelect(userId)
      .where('thread.workspaceId', workspaceId)
      .andWhere('thread.id', threadId)
      .first();
    if (!row) throw new NotFoundError('Thread not found');
    const [summary] = await this.hydrateThreadSummaries([row]);
    return summary;
  }

  /**
   * Rollout readiness for Team Chat threads in this workspace (spec section 7).
   * Authorized (requires current workspace access). `enabled` reflects the backend
   * TEAM_CHAT_THREADS_ENABLED gate; `ready` is true only when EVERY message in the
   * workspace is canonically threaded (has both threadId and sequence) — i.e. no
   * unmapped rows remain and per-message thread invariants hold. The frontend must
   * keep the existing flat UI/context while not (enabled && ready).
   */
  async getTeamChatReadiness(workspaceId: string, userId: string): Promise<TeamThreadReadiness> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const enabled = String(process.env.TEAM_CHAT_THREADS_ENABLED || '').toLowerCase() === 'true';
    // Separate default-OFF Release B gate. Independent of Release A `enabled`, so a
    // fallback of Release B never disables the already-safe Release A context.
    const releaseBEnabled = String(process.env.TEAM_CHAT_RELEASE_B_ENABLED || '').toLowerCase() === 'true';
    // Any message missing a canonical thread OR sequence is unmapped. Both must be
    // present for a valid (threadId, sequence) invariant.
    const unmappedRow = await this.db('workspace_team_messages')
      .where({ workspaceId })
      .andWhere((b) => b.whereNull('threadId').orWhereNull('sequence'))
      .count<{ count: string }[]>('* as count');
    const unmappedMessageCount = Number(unmappedRow[0].count);
    // Additional invariant: no message points at a thread in another workspace.
    const crossWorkspace = await this.db('workspace_team_messages as m')
      .join('workspace_team_threads as t', 't.id', 'm.threadId')
      .where('m.workspaceId', workspaceId)
      .andWhereRaw('m."workspaceId" <> t."workspaceId"')
      .count<{ count: string }[]>('* as count');
    // Additional invariant: every thread's recorded rootMessageId must resolve to
    // a message that belongs to that same thread and workspace. A root that points
    // outside its thread (or at another workspace's message) means the thread's
    // canonical root is not independently retrievable, so reads are not safe.
    const rootMismatch = await this.db('workspace_team_threads as t')
      .leftJoin('workspace_team_messages as root', 'root.id', 't.rootMessageId')
      .where('t.workspaceId', workspaceId)
      .andWhere((b) =>
        b.whereNull('root.id')
          .orWhereRaw('root."threadId" IS DISTINCT FROM t.id')
          .orWhereRaw('root."workspaceId" <> t."workspaceId"'))
      .count<{ count: string }[]>('* as count');
    // Additional invariant: lastMessageSeq must match the actual maximum sequence
    // of the thread's mapped messages (a stale counter would misreport unread/last
    // activity). Threads with zero mapped messages are excluded.
    const seqMismatch = await this.db
      .with('agg', (qb) => {
        qb.select('m.threadId')
          .max('m.sequence as maxSeq')
          .from('workspace_team_messages as m')
          .where('m.workspaceId', workspaceId)
          .whereNotNull('m.threadId')
          .whereNotNull('m.sequence')
          .groupBy('m.threadId');
      })
      .select(this.db.raw('COUNT(*) as count'))
      .from('workspace_team_threads as t')
      .join('agg', 'agg.threadId', 't.id')
      .where('t.workspaceId', workspaceId)
      .andWhereRaw('t."lastMessageSeq" <> agg."maxSeq"')
      .first<{ count: string }>();
    const invariantsOk = Number(crossWorkspace[0].count) === 0
      && Number(rootMismatch[0].count) === 0
      && Number(seqMismatch?.count || 0) === 0;
    const ready = unmappedMessageCount === 0 && invariantsOk;
    return { enabled, ready, unmappedMessageCount, releaseBEnabled };
  }

  async createThread(
    workspaceId: string,
    userId: string,
    input: {
      title?: string;
      body: string;
      mentionedUserIds?: string[];
      references?: Array<Record<string, unknown>>;
      clientMessageId?: string;
    },
  ): Promise<{ thread: TeamThreadSummaryRow; message: WorkspaceTeamMessage }> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to post in Workspace Chat');
    }
    const body = input.body.trim();
    if (!body) throw new HttpError(400, 'Message body is required');

    // Idempotency keyed to the semantic payload. A root create's destination is a
    // new thread, so we key on the author's client id + fingerprint.
    const fingerprint = this.payloadFingerprint({ destination: 'thread:new', body, title: input.title, references: input.references, mentionedUserIds: input.mentionedUserIds });
    {
      const existing = await this.resolveIdempotent(workspaceId, userId, input.clientMessageId, fingerprint);
      if (existing) {
        return {
          thread: await this.getThread(workspaceId, existing.threadId, userId),
          message: await this.getTeamMessage(workspaceId, existing.id, userId),
        };
      }
    }

    const mentionedUserIds = Array.from(new Set(input.mentionedUserIds || []));
    for (const mentionedUserId of mentionedUserIds) {
      await this.ensureMentionTargetHasAccess(workspaceId, mentionedUserId);
    }
    const { collaborators } = await this.workspaceService.listCollaborators(workspaceId, userId);
    const mentionsLumo = this.detectLumoRequest(body, input.references);

    let createdMessageId: string;
    let createdThreadId: string;
    try {
      const result = await this.db.transaction(async (tx) => {
        const { thread, message } = await this.threads.createThreadWithRoot(tx, {
          workspaceId, authorId: userId, title: input.title, body,
          originVersionId: access.currentPublishedVersionId,
          mentionsLumo,
          metadata: { references: input.references || [], ...(mentionsLumo ? { runStatus: 'queued' } : {}) },
          clientMessageId: input.clientMessageId || null,
          clientPayloadHash: input.clientMessageId ? fingerprint : null,
        });
        if (mentionedUserIds.length) {
          await tx('workspace_team_message_mentions').insert(
            mentionedUserIds.map((mentionedUserId) => ({ messageId: message.id, userId: mentionedUserId })),
          );
        }
        // Author follows automatically.
        await tx('workspace_team_thread_user_state')
          .insert({ threadId: thread.id, userId, lastReadSeq: 1, following: true })
          .onConflict(['threadId', 'userId']).merge({ following: true, lastReadSeq: 1, updatedAt: tx.fn.now() });
        // Claim the single active Lumo slot atomically: a concurrent @Lumo send
        // rolls back with 409 THREAD_RUN_ACTIVE and the draft is retained.
        if (mentionsLumo) {
          await this.reserveThreadRunSlot(tx, {
            workspaceId, threadId: thread.id, sourceMessageId: message.id, requestedBy: userId,
            contextCutoffSeq: message.sequence, contextManifest: {}, policySnapshot: {}, contextBuilderVersion: 'thread-ctx-v1',
          });
        }
        for (const recipientUserId of new Set([...collaborators.map((m) => m.userId), ...mentionedUserIds].filter((id) => id !== userId))) {
          const mentioned = mentionedUserIds.includes(recipientUserId);
          await createNotification(tx, {
            recipientUserId,
            eventType: mentioned ? 'chat.mentioned' : 'chat.message',
            resourceType: 'workspace_team_message',
            resourceId: message.id,
            eventKey: message.id,
            payload: { title: mentioned ? 'You were mentioned in team chat' : 'New team chat thread', description: body.slice(0, 500), workspaceId, messageId: message.id, threadId: thread.id, channel: 'team' },
          });
        }
        return { threadId: thread.id, messageId: message.id };
      });
      createdMessageId = result.messageId;
      createdThreadId = result.threadId;
    } catch (error: any) {
      if (error?.code === '23505' && input.clientMessageId) {
        const existing = await this.resolveIdempotent(workspaceId, userId, input.clientMessageId, fingerprint);
        if (existing) {
          return {
            thread: await this.getThread(workspaceId, existing.threadId, userId),
            message: await this.getTeamMessage(workspaceId, existing.id, userId),
          };
        }
      }
      throw error;
    }

    return {
      thread: await this.getThread(workspaceId, createdThreadId, userId),
      message: await this.getTeamMessage(workspaceId, createdMessageId, userId),
    };
  }

  async postThreadMessage(
    workspaceId: string,
    threadId: string,
    userId: string,
    input: {
      body: string;
      replyToMessageId?: string;
      mentionedUserIds?: string[];
      references?: Array<Record<string, unknown>>;
      clientMessageId?: string;
    },
  ): Promise<WorkspaceTeamMessage> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new AccessDeniedError('Commenter access is required to post in Workspace Chat');
    }
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');

    const body = input.body.trim();
    if (!body) throw new HttpError(400, 'Message body is required');

    const fingerprint = this.payloadFingerprint({ destination: `thread:${threadId}`, body, replyToMessageId: input.replyToMessageId, references: input.references, mentionedUserIds: input.mentionedUserIds });
    {
      const existing = await this.resolveIdempotent(workspaceId, userId, input.clientMessageId, fingerprint, threadId);
      if (existing) return this.getTeamMessage(workspaceId, existing.id, userId);
    }

    // Optional quote must be inside the same thread.
    if (input.replyToMessageId) {
      const quoted = await this.db('workspace_team_messages')
        .where({ id: input.replyToMessageId, workspaceId })
        .first();
      if (!quoted || quoted.threadId !== threadId) {
        throw new HttpError(400, 'The quoted message is not in this thread');
      }
    }

    const mentionedUserIds = Array.from(new Set(input.mentionedUserIds || []));
    for (const mentionedUserId of mentionedUserIds) {
      await this.ensureMentionTargetHasAccess(workspaceId, mentionedUserId);
    }
    const { collaborators } = await this.workspaceService.listCollaborators(workspaceId, userId);
    const mentionsLumo = this.detectLumoRequest(body, input.references);

    let insertedId: string;
    try {
      insertedId = await this.db.transaction(async (tx) => {
        const inserted = await this.threads.appendMessage(tx, {
          workspaceId, threadId, authorId: userId, authorType: 'user', body,
          originVersionId: access.currentPublishedVersionId,
          replyToMessageId: input.replyToMessageId || null,
          mentionsLumo,
          metadata: { references: input.references || [], ...(mentionsLumo ? { runStatus: 'queued' } : {}) },
          clientMessageId: input.clientMessageId || null,
          clientPayloadHash: input.clientMessageId ? fingerprint : null,
        });
        if (mentionedUserIds.length) {
          await tx('workspace_team_message_mentions').insert(
            mentionedUserIds.map((mentionedUserId) => ({ messageId: inserted.id, userId: mentionedUserId })),
          );
        }
        // Posting follows the thread automatically.
        await tx('workspace_team_thread_user_state')
          .insert({ threadId, userId, lastReadSeq: inserted.sequence, following: true })
          .onConflict(['threadId', 'userId']).merge({ following: true, updatedAt: tx.fn.now() });
        // Claim the single active Lumo slot atomically before the response.
        if (mentionsLumo) {
          await this.reserveThreadRunSlot(tx, {
            workspaceId, threadId, sourceMessageId: inserted.id, requestedBy: userId,
            contextCutoffSeq: inserted.sequence, contextManifest: {}, policySnapshot: {}, contextBuilderVersion: 'thread-ctx-v1',
          });
        }
        // Reply notifications go to followers and explicit mentions, excluding the sender.
        const followerRows = await tx('workspace_team_thread_user_state')
          .where({ threadId, following: true }).select('userId');
        const followerIds = followerRows.map((r: any) => r.userId);
        const memberIds = new Set(collaborators.map((m) => m.userId));
        const recipients = new Set(
          [...followerIds, ...mentionedUserIds]
            .filter((id) => id !== userId && (memberIds.has(id) || mentionedUserIds.includes(id))),
        );
        for (const recipientUserId of recipients) {
          const mentioned = mentionedUserIds.includes(recipientUserId);
          await createNotification(tx, {
            recipientUserId,
            eventType: mentioned ? 'chat.mentioned' : 'chat.message',
            resourceType: 'workspace_team_message',
            resourceId: inserted.id,
            eventKey: inserted.id,
            payload: { title: mentioned ? 'You were mentioned in team chat' : 'New reply in a team thread', description: body.slice(0, 500), workspaceId, messageId: inserted.id, threadId, channel: 'team' },
          });
        }
        return inserted.id;
      });
    } catch (error: any) {
      if (error?.code === '23505' && input.clientMessageId) {
        const existing = await this.resolveIdempotent(workspaceId, userId, input.clientMessageId, fingerprint, threadId);
        if (existing) return this.getTeamMessage(workspaceId, existing.id, userId);
      }
      throw error;
    }
    return this.getTeamMessage(workspaceId, insertedId, userId);
  }

  async listThreadMessages(
    workspaceId: string,
    threadId: string,
    userId: string,
    options: { beforeSeq?: number; afterSeq?: number; aroundMessageId?: string; limit?: number } = {},
  ): Promise<ThreadMessagePage> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.getThread(workspaceId, threadId, userId);
    const limit = Math.min(Math.max(options.limit || THREAD_MESSAGE_DEFAULT_LIMIT, 1), THREAD_MESSAGE_MAX_LIMIT);

    const modes = [options.beforeSeq !== undefined, options.afterSeq !== undefined, Boolean(options.aroundMessageId)].filter(Boolean);
    if (modes.length > 1) throw new HttpError(400, 'Provide only one of beforeSeq, afterSeq, aroundMessageId');

    let rows: WorkspaceTeamMessage[];
    if (options.aroundMessageId) {
      const target = await this.db('workspace_team_messages')
        .where({ id: options.aroundMessageId, workspaceId, threadId }).first();
      if (!target) throw new HttpError(400, 'Target message is not in this thread');
      const half = Math.floor(limit / 2);
      const older = await this.teamMessageQuery(userId)
        .where('message.threadId', threadId).andWhere('message.sequence', '<', target.sequence)
        .orderBy('message.sequence', 'desc').limit(half);
      const newer = await this.teamMessageQuery(userId)
        .where('message.threadId', threadId).andWhere('message.sequence', '>=', target.sequence)
        .orderBy('message.sequence', 'asc').limit(limit - half);
      rows = [...(older as WorkspaceTeamMessage[]).reverse(), ...(newer as WorkspaceTeamMessage[])];
    } else if (options.afterSeq !== undefined) {
      rows = await this.teamMessageQuery(userId)
        .where('message.threadId', threadId).andWhere('message.sequence', '>', options.afterSeq)
        .orderBy('message.sequence', 'asc').limit(limit) as WorkspaceTeamMessage[];
    } else {
      const before = options.beforeSeq;
      rows = (await this.teamMessageQuery(userId)
        .where('message.threadId', threadId)
        .modify((q) => { if (before !== undefined) q.andWhere('message.sequence', '<', before); })
        .orderBy('message.sequence', 'desc').limit(limit) as WorkspaceTeamMessage[]).reverse();
    }

    const seqs = rows.map((m) => (m as any).sequence as number).filter((s) => s != null);
    const minSeq = seqs.length ? Math.min(...seqs) : 0;
    const maxSeq = seqs.length ? Math.max(...seqs) : 0;
    const hasOlder = minSeq > 1 && seqs.length > 0;
    const hasNewer = maxSeq < Number(thread.lastMessageSeq) && seqs.length > 0;
    return {
      thread,
      messages: rows,
      olderCursor: hasOlder ? String(minSeq) : null,
      newerCursor: hasNewer ? String(maxSeq) : null,
      hasOlder,
      hasNewer,
    };
  }

  async patchThread(
    workspaceId: string,
    threadId: string,
    userId: string,
    input: { title?: string; status?: 'open' | 'resolved' },
  ): Promise<TeamThreadSummaryRow> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');
    const canModerate = canModerateWorkspaceCollaboration(access.membership.role);
    if (!canModerate && thread.createdBy !== userId) {
      throw new AccessDeniedError('Only the thread author or a Publisher can rename or resolve a thread');
    }
    const patch: Record<string, unknown> = { updatedAt: this.db.fn.now() };
    if (input.title !== undefined) patch.title = deriveThreadTitle(input.title, input.title);
    if (input.status === 'resolved') { patch.status = 'resolved'; patch.resolvedAt = this.db.fn.now(); patch.resolvedBy = userId; }
    if (input.status === 'open') { patch.status = 'open'; patch.resolvedAt = null; patch.resolvedBy = null; }
    await this.db('workspace_team_threads').where({ id: threadId }).update(patch);
    return this.getThread(workspaceId, threadId, userId);
  }

  async setThreadReadState(workspaceId: string, threadId: string, userId: string, lastReadSeq: number): Promise<{ lastReadSeq: number }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');
    // Clamp to a valid sequence and advance monotonically.
    const clamped = Math.max(0, Math.min(Math.floor(lastReadSeq), Number(thread.lastMessageSeq || 0)));
    await this.db('workspace_team_thread_user_state')
      .insert({ threadId, userId, lastReadSeq: clamped, following: false })
      .onConflict(['threadId', 'userId'])
      .merge({ lastReadSeq: this.db.raw('GREATEST(workspace_team_thread_user_state."lastReadSeq", ?)', [clamped]), updatedAt: this.db.fn.now() });
    const state = await this.db('workspace_team_thread_user_state').where({ threadId, userId }).first();
    return { lastReadSeq: Number(state?.lastReadSeq || clamped) };
  }

  async setThreadFollowState(workspaceId: string, threadId: string, userId: string, following: boolean): Promise<{ following: boolean }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');
    await this.db('workspace_team_thread_user_state')
      .insert({ threadId, userId, following, lastReadSeq: 0 })
      .onConflict(['threadId', 'userId'])
      .merge({ following, updatedAt: this.db.fn.now() });
    return { following };
  }

  /**
   * Resolve the owning thread for a message id (deep-link compatibility). Never
   * silently falls back; lazily migrates a legacy group if needed.
   */
  async resolveThreadForMessage(workspaceId: string, messageId: string, userId: string): Promise<{ message: WorkspaceTeamMessage; threadId: string; sequence: number | null }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const message = await this.getTeamMessage(workspaceId, messageId, userId);
    let threadId = (message as any).threadId as string | null;
    if (!threadId) {
      const legacyRoot = message.id;
      threadId = await this.db.transaction((tx) => this.threads.ensureThreadForLegacyRoot(tx, workspaceId, legacyRoot));
    }
    const refreshed = await this.db('workspace_team_messages').where({ id: messageId, workspaceId }).first();
    return { message, threadId: threadId as string, sequence: refreshed?.sequence ?? null };
  }

  // --- Durable thread run dispatch (Release A, F3) -----------------------

  /**
   * Build the thread-scoped context for a Lumo run (spec F3). Rechecks access,
   * verifies the source belongs to the requested workspace/thread, captures the
   * source's sequence as an immutable cutoff, and returns history plus a manifest
   * recording the included message IDs, cutoff, references, and builder version.
   */
  async buildThreadContext(
    workspaceId: string,
    userId: string,
    sourceMessageId: string,
    options: { charBudget?: number } = {},
  ): Promise<{
    source: WorkspaceTeamMessage;
    threadId: string;
    cutoffSeq: number;
    history: WorkspaceTeamAgentHistoryMessage[];
    quote: WorkspaceTeamAgentHistoryMessage | null;
    sourceExcerpt: WorkspaceTeamContextExcerpt | null;
    manifest: Record<string, unknown>;
    contextBuilderVersion: string;
  }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const source = await this.getTeamMessage(workspaceId, sourceMessageId, userId);
    const threadId = (source as any).threadId as string | null;
    const cutoffSeq = Number((source as any).sequence);
    if (!threadId || !Number.isFinite(cutoffSeq)) {
      throw new HttpError(409, 'The Lumo request is not attached to a thread');
    }

    // The 24k budget constrains the ACTUAL serialized runner input: the fixed
    // prompt scaffold, the source question, rendered reference metadata, the
    // quote notice, the truncation notice, and every serialized history message.
    // Nothing is force-added past the budget; oversized messages are excerpted
    // and the untruncated original is retrievable through the authenticated
    // thread-history reader (spec F3.4). Approximate ~4 chars/token.
    const charBudget = options.charBudget ?? TEAM_CONTEXT_CHAR_BUDGET;

    // Resolve and PIN references first: their rendered metadata occupies real
    // budget, and the pinned versions must be recorded immutably (spec F3.5/F3.7).
    const references = ((source.metadata?.references || []) as Array<Record<string, unknown>>).filter((r) => r.kind === 'file');
    const referenceVersionIds: string[] = [];
    const pinnedReferences: Array<Record<string, unknown>> = [];
    for (const ref of references) {
      if (ref.publishedVersionId) {
        // A published version is already an immutable snapshot id; record it as
        // the pin. The authoritative snapshot read happens in resolveReferences
        // at prepare time and fails loudly there if the version is missing, so we
        // do not silently fall back to live Working here.
        referenceVersionIds.push(String(ref.publishedVersionId));
        pinnedReferences.push({ ...ref });
        continue;
      }
      const fileId = Number(ref.id);
      if (!Number.isFinite(fileId)) {
        throw new HttpError(400, 'A referenced file id is invalid');
      }
      // Explicit workspace condition on BOTH branches: a Working reference must
      // belong to this workspace before it is pinned (spec: reference authz).
      const row = ref.version
        ? await this.db('file_versions').where({ workspaceId, fileId, version: Number(ref.version) }).select('id', 'version').first()
        : await this.db('files as f')
          .leftJoin('file_versions as v', 'v.id', 'f.currentVersionId')
          .where('f.id', fileId)
          .andWhere('f.workspaceId', workspaceId)
          .select('v.id as id', 'v.version as version').first();
      if (!row?.id) {
        // Fail closed: never silently substitute a live Working version for a
        // reference whose immutable version cannot be resolved (spec F3.5).
        throw new HttpError(409, 'A referenced file version could not be resolved to an immutable pin');
      }
      referenceVersionIds.push(String(row.id));
      pinnedReferences.push({ ...ref, version: Number(row.version) });
    }

    // F8: explicit, version-pinned ANNOTATION references. Resolved to the pinned
    // anchor version's recorded excerpt (never a live re-read), authorized to this
    // workspace, workspace-audience only. Recorded in the manifest so a retry
    // reproduces the SAME pinned excerpt and never re-fetches a live/edited
    // annotation. Linking alone never adds these — only an explicit reference in
    // the invocation. Their excerpt text occupies real budget below.
    const annotationRefs = ((source.metadata?.references || []) as Array<Record<string, unknown>>).filter((r) => r.kind === 'annotation');
    const pinnedAnnotations: Array<{ objectId: string; anchorVersionId: string | null; excerpt: string; body: string; title: string | null; filePath: string | null; excerptTruncated?: boolean; bodyTruncated?: boolean; originalExcerptLength?: number; originalBodyLength?: number; fullExcerpt?: string; fullBody?: string }> = [];
    let annotationChars = 0;
    // Bound the TOTAL annotation footprint so oversized annotations cannot starve
    // the source question. Reserve at most ~1/3 of the budget for all pinned
    // annotations combined; each annotation's excerpt+body is truncated to fit its
    // fair share for the PROMPT, but the FULL payload is retained in the manifest
    // (server-only) so prepare() can materialize an authorized frozen reference
    // file for exact full retrieval. Retries reproduce the SAME frozen content.
    const annotationTotalCap = Math.floor(charBudget / 3);
    // Double-serialized fit: the section is JSON-stringified once for the prompt
    // and the prompt is serialized again by the runner. Find the largest character
    // prefix whose DOUBLE-serialized length fits a room budget.
    const doubleLen = (s: string) => JSON.stringify(JSON.stringify(s)).length;
    const fitDouble = (s: string, room: number): number => {
      if (doubleLen(s) <= room) return s.length;
      let lo = 0; let hi = s.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (doubleLen(s.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    for (const ref of annotationRefs) {
      const resolved = await this.resolveAnnotationReference(workspaceId, userId, { id: String(ref.id), anchorVersionId: ref.anchorVersionId ? String(ref.anchorVersionId) : undefined });
      // Per-annotation room (double-serialized), reserving structural overhead.
      const perRoom = Math.max(0, Math.floor(annotationTotalCap / annotationRefs.length) - doubleLen(resolved.title || '') - HISTORY_MESSAGE_OVERHEAD_CHARS * 2);
      const excerptRoom = Math.floor(perRoom / 2);
      const bodyRoom = perRoom - excerptRoom;
      const originalExcerptLength = resolved.excerpt.length;
      const originalBodyLength = resolved.body.length;
      const excerpt = resolved.excerpt.slice(0, fitDouble(resolved.excerpt, excerptRoom));
      const body = resolved.body.slice(0, fitDouble(resolved.body, bodyRoom));
      const excerptTruncated = excerpt.length < originalExcerptLength;
      const bodyTruncated = body.length < originalBodyLength;
      pinnedAnnotations.push({ objectId: resolved.objectId, anchorVersionId: resolved.anchorVersionId, excerpt, body, title: resolved.title, filePath: resolved.filePath, excerptTruncated, bodyTruncated, originalExcerptLength, originalBodyLength, fullExcerpt: resolved.excerpt, fullBody: resolved.body });
      pinnedReferences.push({ kind: 'annotation', id: resolved.objectId, anchorVersionId: resolved.anchorVersionId, label: ref.label });
      // The annotation section is embedded in the prompt AS a JSON string, and the
      // whole prompt is then serialized again by the runner — so its cost is the
      // DOUBLE-serialized length. Account for that (nested escaping) so the source
      // question keeps priority and the real serialized input stays within budget.
      const sectionJson = JSON.stringify({ annotation: resolved.objectId, title: resolved.title, filePath: resolved.filePath, anchorVersionId: resolved.anchorVersionId, excerpt, feedback: body });
      annotationChars += JSON.stringify(sectionJson).length + HISTORY_MESSAGE_OVERHEAD_CHARS;
    }

    // Fixed prompt scaffold + reference/quote/truncation overhead in the SAME
    // shape prepare() emits, so the budget reflects the real prompt size.
    const question = source.body.replace(/(^|\s)@lumo\b[:,]?/ig, '$1').trim() || source.body;
    const scaffold = TEAM_PROMPT_SCAFFOLD_CHARS
      + source.authorName.length
      + referenceOverheadChars(pinnedReferences.length)
      + annotationChars
      + (source.replyToMessageId ? QUOTE_NOTICE_CHARS : 0);

    // The source question is the current prompt. It is always present; if it
    // alone would exceed the budget it is excerpted (its exact original stays
    // retrievable by cutoff sequence through the authenticated reader).
    let sourceExcerpt: WorkspaceTeamContextExcerpt | null = null;
    // Account for the source question in SERIALIZED (JSON-escaped) terms so a
    // question full of quotes/backslashes/newlines cannot blow the real input
    // past budget. The recorded includedLength is a CHARACTER count (prepare()
    // slices the raw question by it); we find the largest character prefix whose
    // serialized length fits the remaining room, and persist that decision in the
    // manifest so a retry reproduces the identical (possibly-excerpted) question.
    const serializedLenSource = (s: string) => JSON.stringify(s).length;
    const fitSerialized = (s: string, room: number): number => {
      if (serializedLenSource(s) <= room) return s.length;
      let lo = 0; let hi = s.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (serializedLenSource(s.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    let sourceQuestionChars = question.length;
    let sourceQuestionCost = serializedLenSource(question);
    const scaffoldFloor = scaffold + TRUNCATION_NOTICE_CHARS;
    if (scaffoldFloor + sourceQuestionCost > charBudget) {
      const room = Math.max(0, charBudget - scaffoldFloor);
      const keepChars = fitSerialized(question, room);
      sourceQuestionChars = keepChars;
      sourceQuestionCost = serializedLenSource(question.slice(0, keepChars));
      sourceExcerpt = { messageId: source.id, sequence: cutoffSeq, role: 'source', originalLength: question.length, includedLength: keepChars };
    }

    // Bounded history retrieval: never a full-thread scan. Fetch the newest page
    // (descending LIMIT) plus explicit root/quote lookups by id, then dedupe.
    const pageLimit = TEAM_CONTEXT_HISTORY_PAGE;
    const historySelect = ['message.id', 'message.sequence', 'message.authorType', 'message.body', this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`)];
    const baseHistoryQuery = () => this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.workspaceId', workspaceId)
      .andWhere('message.threadId', threadId)
      .andWhere('message.sequence', '<', cutoffSeq)
      .whereNot('message.id', sourceMessageId)
      .whereIn('message.authorType', ['user', 'lumo'])
      .whereRaw(`COALESCE(message.metadata->>'runStatus', 'completed') NOT IN ('queued', 'running', 'awaiting_approval', 'awaiting_input')`);

    const recentDesc = await baseHistoryQuery()
      .orderBy('message.sequence', 'desc')
      .limit(pageLimit)
      .select(historySelect as any);
    // The lowest sequence still on the newest page bounds omitted-range math so a
    // huge older history is summarized as one aggregated omitted range, never
    // scanned row-by-row.
    const pageFloorSeq = recentDesc.length ? Number(recentDesc[recentDesc.length - 1].sequence) : 1;
    const pageIsPartial = recentDesc.length === pageLimit;

    const toHistory = (row: any): WorkspaceTeamAgentHistoryMessage & { sequence: number } => ({
      id: row.id, sequence: Number(row.sequence),
      role: row.authorType === 'lumo' ? 'assistant' : 'user',
      authorName: row.authorType === 'lumo' ? 'Lumo' : row.authorName,
      content: row.body,
    });

    // Explicit root lookup by the thread's recorded rootMessageId (bounded, by id).
    const threadRow = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    const rootId = threadRow?.rootMessageId as string | null;
    let root: (WorkspaceTeamAgentHistoryMessage & { sequence: number }) | null = null;
    if (rootId) {
      const cached = recentDesc.find((r: any) => r.id === rootId);
      if (cached) root = toHistory(cached);
      else {
        const rootRow = await baseHistoryQuery().andWhere('message.id', rootId).select(historySelect as any).first();
        if (rootRow) root = toHistory(rootRow);
      }
    }

    // Explicit quote lookup by id, only within this workspace/thread/cutoff.
    let quote: (WorkspaceTeamAgentHistoryMessage & { sequence: number }) | null = null;
    if (source.replyToMessageId) {
      const cached = recentDesc.find((r: any) => r.id === source.replyToMessageId);
      if (cached) quote = toHistory(cached);
      else {
        const quoteRow = await baseHistoryQuery().andWhere('message.id', source.replyToMessageId).select(historySelect as any).first();
        if (quoteRow) quote = toHistory(quoteRow);
      }
    }

    // Serialized cost mirrors prepare()'s agentHistory shape but uses a
    // conservative JSON-escaped upper bound (JSON.stringify accounts for escaped
    // quotes/backslashes/newlines and control characters that a raw .length
    // ignores) so the real serialized runner input stays within budget even for
    // heavily-escaped content. This is what the runner actually receives.
    const serializedLen = (s: string) => JSON.stringify(s).length; // includes quotes + escaping
    const cost = (m: WorkspaceTeamAgentHistoryMessage & { sequence: number }) =>
      (m.role === 'user' ? serializedLen(m.authorName) + 2 : 0) + serializedLen(m.content) + HISTORY_MESSAGE_OVERHEAD_CHARS;

    // Budget accounting starts from the fixed scaffold plus the (possibly
    // excerpted) source question and the truncation-notice reservation.
    let used = scaffold + sourceQuestionCost + TRUNCATION_NOTICE_CHARS;
    const selected = new Map<string, WorkspaceTeamAgentHistoryMessage & { sequence: number }>();
    const excerpts: WorkspaceTeamContextExcerpt[] = [];
    if (sourceExcerpt) excerpts.push(sourceExcerpt);

    // Priority: source (already reserved) > quote > root > recent messages.
    // A prioritized message that does not fit in full is EXCERPTED to fit the
    // remaining budget rather than force-added past it.
    const addWithExcerpt = (m: (WorkspaceTeamAgentHistoryMessage & { sequence: number }) | null, prioritized: boolean): boolean => {
      if (!m || selected.has(m.id)) return true;
      const full = cost(m);
      if (used + full <= charBudget) {
        selected.set(m.id, m); used += full; return true;
      }
      if (!prioritized) return false;
      const structural = (m.role === 'user' ? serializedLen(m.authorName) + 2 : 0) + HISTORY_MESSAGE_OVERHEAD_CHARS;
      const room = charBudget - used - structural;
      if (room <= 0) {
        // No room even for the header; record an excerpt of length 0 so the agent
        // knows the message exists and can retrieve it by sequence.
        const excerpted = { ...m, content: '', excerpt: { sequence: m.sequence, originalLength: m.content.length, includedLength: 0, truncated: true as const } };
        selected.set(m.id, excerpted); used += structural;
        excerpts.push({ messageId: m.id, sequence: m.sequence, role: m.role, originalLength: m.content.length, includedLength: 0 });
        return true;
      }
      // Fit the largest CHARACTER prefix whose SERIALIZED length fits `room`.
      const keepChars = fitSerialized(m.content, room);
      const kept = m.content.slice(0, keepChars);
      const excerpted = { ...m, content: kept, excerpt: { sequence: m.sequence, originalLength: m.content.length, includedLength: kept.length, truncated: true as const } };
      selected.set(m.id, excerpted); used += structural + serializedLen(kept);
      excerpts.push({ messageId: m.id, sequence: m.sequence, role: m.role, originalLength: m.content.length, includedLength: kept.length });
      return true;
    };

    addWithExcerpt(quote, true);
    addWithExcerpt(root, true);
    // Fill remaining budget with the most recent complete messages (never
    // excerpted; they either fit whole or are omitted and reported).
    for (const row of recentDesc) {
      const m = toHistory(row);
      if (selected.has(m.id)) continue;
      if (!addWithExcerpt(m, false)) break;
    }

    const history = [...selected.values()].sort((a, b) => a.sequence - b.sequence).map(({ sequence, ...rest }) => rest);
    const includedSeqs = new Set([...selected.values()].map((m) => m.sequence));

    // Omitted ranges: bounded computation. Everything below the newest page floor
    // (if the thread is larger than one page) is aggregated, but explicitly
    // INCLUDED sequences (e.g. an old root/quote pulled in by id) are carved out
    // so a sequence is never reported as both included and omitted.
    const omittedRanges: Array<[number, number]> = [];
    const includedBelowFloor = [...includedSeqs].filter((s) => s < pageFloorSeq).sort((a, b) => a - b);
    if (pageIsPartial && pageFloorSeq > 1) {
      // Split [1, pageFloorSeq-1] around any included sequences in that span.
      let cursor = 1;
      for (const inc of includedBelowFloor) {
        if (inc > cursor) omittedRanges.push([cursor, inc - 1]);
        cursor = Math.max(cursor, inc + 1);
      }
      if (cursor <= pageFloorSeq - 1) omittedRanges.push([cursor, pageFloorSeq - 1]);
    }
    const pageSeqs = recentDesc.map((r: any) => Number(r.sequence)).sort((a: number, b: number) => a - b);
    let runStart: number | null = null;
    for (const seq of pageSeqs) {
      if (!includedSeqs.has(seq)) {
        if (runStart === null) runStart = seq;
      } else if (runStart !== null) {
        omittedRanges.push([runStart, seq - 1]); runStart = null;
      }
    }
    if (runStart !== null) omittedRanges.push([runStart, cutoffSeq - 1]);
    omittedRanges.sort((a, b) => a[0] - b[0]);

    const manifest = {
      threadId,
      cutoffSeq,
      includedMessageIds: [...selected.keys()],
      rootMessageId: root?.id || null,
      quotedMessageId: quote?.id || null,
      referenceVersionIds,
      pinnedReferences,
      pinnedAnnotations,
      omittedRanges,
      excerpts,
      truncated: omittedRanges.length > 0 || excerpts.length > 0,
      charBudget,
      // The excerpting decisions per included message so retries reproduce the
      // exact same truncated bodies from the recorded selection.
      excerptedMessageIds: Object.fromEntries(
        [...selected.values()].filter((m) => m.excerpt).map((m) => [m.id, m.excerpt!.includedLength]),
      ),
      sourceIncludedLength: sourceExcerpt ? sourceExcerpt.includedLength : question.length,
    };
    return {
      source, threadId, cutoffSeq, history,
      quote: quote ? { id: quote.id, role: quote.role, authorName: quote.authorName, content: quote.content, ...(quote.excerpt ? { excerpt: quote.excerpt } : {}) } : null,
      sourceExcerpt,
      manifest, contextBuilderVersion: TEAM_CONTEXT_BUILDER_VERSION,
    };
  }

  /**
   * Reconstruct the agent context from a previously recorded immutable manifest
   * (spec F3.7). Used on retries/recovery so the run reuses the recorded message
   * selection and never pulls in messages created after the original cutoff.
   * Every recorded id is validated against the manifest's thread and cutoff and
   * the current workspace so a manifest can never resurrect another thread's or
   * a post-cutoff message.
   */
  async loadContextFromManifest(
    workspaceId: string,
    manifest: {
      includedMessageIds?: string[];
      rootMessageId?: string | null;
      quotedMessageId?: string | null;
      threadId?: string;
      cutoffSeq?: number;
      omittedRanges?: Array<[number, number]>;
      excerptedMessageIds?: Record<string, number>;
    },
  ): Promise<{ history: WorkspaceTeamAgentHistoryMessage[]; quote: WorkspaceTeamAgentHistoryMessage | null }> {
    const ids = manifest.includedMessageIds || [];
    if (!ids.length) return { history: [], quote: null };
    const query = this.db('workspace_team_messages as message')
      .leftJoin('users as author', 'author.id', 'message.authorId')
      .where('message.workspaceId', workspaceId)
      .whereIn('message.id', ids);
    // Enforce the recorded thread scope and cutoff. A recorded manifest must only
    // reproduce messages from its own thread, strictly before its cutoff.
    if (manifest.threadId) query.andWhere('message.threadId', manifest.threadId);
    if (Number.isFinite(Number(manifest.cutoffSeq))) query.andWhere('message.sequence', '<', Number(manifest.cutoffSeq));
    const rows = await query
      .orderBy('message.sequence', 'asc')
      .select('message.id', 'message.sequence', 'message.authorType', 'message.body', this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`));
    const excerptLengths = manifest.excerptedMessageIds || {};
    const toHistory = (row: any): WorkspaceTeamAgentHistoryMessage => {
      const role = row.authorType === 'lumo' ? 'assistant' : 'user';
      const authorName = row.authorType === 'lumo' ? 'Lumo' : row.authorName;
      const includedLength = excerptLengths[row.id];
      if (includedLength !== undefined && includedLength < String(row.body).length) {
        // Reproduce the exact recorded excerpt so retries never widen the input.
        return {
          id: row.id, role, authorName,
          content: String(row.body).slice(0, includedLength),
          excerpt: { sequence: Number(row.sequence), originalLength: String(row.body).length, includedLength, truncated: true },
        };
      }
      return { id: row.id, role, authorName, content: row.body };
    };
    const history = rows.map(toHistory);
    const quote = manifest.quotedMessageId ? history.find((m) => m.id === manifest.quotedMessageId) || null : null;
    return { history, quote };
  }

  /**
   * Retrieve exact thread history for an authenticated agent reader (spec F3.4:
   * "expose an authenticated thread-history reader for exact retrieval"). The
   * range and page size are bounded so a single call can never scan an entire
   * thread. An optional cutoff clamps the upper bound to the run's immutable
   * context cutoff so the agent can never read messages created after its run
   * began.
   */
  async readThreadHistoryRange(
    workspaceId: string,
    userId: string,
    threadId: string,
    fromSeq: number,
    toSeq: number,
    options: { limit?: number; cutoffSeq?: number; sourceMessageId?: string } = {},
  ): Promise<{ messages: WorkspaceTeamAgentHistoryMessage[]; hasMore: boolean; nextFromSeq: number | null }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const maxLimit = 100;
    const limit = Math.min(Math.max(1, options.limit ?? maxLimit), maxLimit);
    const lowerBound = Math.max(0, Math.floor(fromSeq));
    const cutoffSeq = Number.isFinite(Number(options.cutoffSeq)) ? Number(options.cutoffSeq) : null;
    const requestedUpper = Math.floor(toSeq);
    // History is bounded to strictly-before-cutoff so the agent can never read
    // messages created after its run began. The one exception is the run's OWN
    // immutable source request at exactly the cutoff, retrievable by its bound id
    // (spec F3.4: exact retrieval of an excerpted source request). Later messages
    // remain denied.
    let upperBound = requestedUpper;
    if (cutoffSeq !== null) upperBound = Math.min(upperBound, cutoffSeq - 1);
    const toHistory = (row: any): WorkspaceTeamAgentHistoryMessage => ({
      id: row.id,
      role: row.authorType === 'lumo' ? 'assistant' : 'user',
      authorName: row.authorType === 'lumo' ? 'Lumo' : row.authorName,
      content: row.body,
    });

    const messages: WorkspaceTeamAgentHistoryMessage[] = [];
    let hasMore = false;
    let nextFromSeq: number | null = null;

    if (upperBound >= lowerBound) {
      const rows = await this.db('workspace_team_messages as message')
        .leftJoin('users as author', 'author.id', 'message.authorId')
        .where('message.workspaceId', workspaceId)
        .andWhere('message.threadId', threadId)
        .andWhere('message.sequence', '>=', lowerBound)
        .andWhere('message.sequence', '<=', upperBound)
        .whereIn('message.authorType', ['user', 'lumo'])
        .orderBy('message.sequence', 'asc')
        .limit(limit + 1)
        .select('message.id', 'message.sequence', 'message.authorType', 'message.body', this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`));
      hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      nextFromSeq = hasMore ? Number(page[page.length - 1].sequence) + 1 : null;
      for (const row of page) messages.push(toHistory(row));
    }

    // Exact source-request retrieval: only when the caller's requested range
    // reaches the cutoff AND a bound source id is present. Fetched strictly by
    // that id at the cutoff sequence — never a general read at/after cutoff.
    if (cutoffSeq !== null && options.sourceMessageId && requestedUpper >= cutoffSeq && !hasMore) {
      const sourceRow = await this.db('workspace_team_messages as message')
        .leftJoin('users as author', 'author.id', 'message.authorId')
        .where('message.workspaceId', workspaceId)
        .andWhere('message.threadId', threadId)
        .andWhere('message.id', options.sourceMessageId)
        .andWhere('message.sequence', cutoffSeq)
        .whereIn('message.authorType', ['user', 'lumo'])
        .select('message.id', 'message.sequence', 'message.authorType', 'message.body', this.db.raw(`COALESCE(author."displayName", 'Workspace member') as "authorName"`))
        .first();
      if (sourceRow) messages.push(toHistory(sourceRow));
    }

    return { messages, hasMore, nextFromSeq };
  }

  /**
   * Claim the single active run slot for a thread and persist a durable dispatch
   * identity BEFORE the runner is called. The partial unique index
   * (threadId WHERE status active) and unique(sourceMessageId) enforce that a
   * second concurrent invocation cannot also claim the slot. Returns the durable
   * run row, or throws a typed 409 THREAD_RUN_ACTIVE.
   */
  async claimThreadRunSlot(params: {
    workspaceId: string;
    threadId: string;
    sourceMessageId: string;
    requestedBy: string;
    contextCutoffSeq: number;
    contextManifest: Record<string, unknown>;
    policySnapshot: Record<string, unknown>;
    contextBuilderVersion: string;
  }): Promise<{ id: string; isNew: boolean }> {
    // If a run already exists for this exact source message, reuse it (idempotent
    // recovery). Otherwise attempt to claim; a unique violation means either the
    // same source raced (reuse) or another active run holds the thread slot (409).
    return this.reserveThreadRunSlot(this.db, params);
  }

  /**
   * Transaction-aware slot reservation. Called inside the message-creation
   * transaction so that a second concurrent @Lumo send is rejected with 409
   * THREAD_RUN_ACTIVE atomically (the message is not created; the draft is kept).
   * Also used for recovery via the top-level db.
   */
  async reserveThreadRunSlot(
    executor: Knex | Knex.Transaction,
    params: {
      workspaceId: string;
      threadId: string;
      sourceMessageId: string;
      requestedBy: string;
      contextCutoffSeq: number;
      contextManifest: Record<string, unknown>;
      policySnapshot: Record<string, unknown>;
      contextBuilderVersion: string;
    },
  ): Promise<{ id: string; isNew: boolean }> {
    const existing = await executor('workspace_team_thread_runs').where({ sourceMessageId: params.sourceMessageId }).first();
    if (existing) return { id: existing.id, isNew: false };
    const id = uuidv4();
    // Persist the stable runner identity BEFORE dispatch. The durable row — not
    // the external runner call — is the source of truth for the run identity, so
    // a crash between dispatch and persisting the runner's returned id cannot
    // desynchronize SQL from the runtime run, and recovery reuses this exact id.
    const runId = uuidv4();
    try {
      await executor('workspace_team_thread_runs').insert({
        id,
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        sourceMessageId: params.sourceMessageId,
        runId,
        status: 'queued',
        requestedBy: params.requestedBy,
        contextCutoffSeq: params.contextCutoffSeq,
        contextManifest: JSON.stringify(params.contextManifest),
        policySnapshot: JSON.stringify(params.policySnapshot),
        contextBuilderVersion: params.contextBuilderVersion,
      });
      return { id, isNew: true };
    } catch (error: any) {
      if (error?.code === '23505') {
        // We already reused an existing same-source run above; a unique violation
        // here means the active-slot partial unique index rejected a SECOND
        // nonterminal run for this thread. We must NOT query again on an aborted
        // transaction — throw the typed 409 so the whole send rolls back and the
        // client draft is retained.
        throw new HttpError(409, 'A Lumo request is already active in this thread', { code: 'THREAD_RUN_ACTIVE' });
      }
      throw error;
    }
  }

  async getThreadRunBySource(sourceMessageId: string): Promise<any | null> {
    return (await this.db('workspace_team_thread_runs').where({ sourceMessageId }).first()) || null;
  }

  async getThreadRunById(dispatchId: string): Promise<any | null> {
    return (await this.db('workspace_team_thread_runs').where({ id: dispatchId }).first()) || null;
  }

  async saveThreadRunRunId(dispatchId: string, runId: string, status: string): Promise<void> {
    await this.db('workspace_team_thread_runs').where({ id: dispatchId }).update({ runId, status, updatedAt: this.db.fn.now() });
  }

  /**
   * Persist the durable dispatch-attempt phase BEFORE the runner is invoked, using
   * the provided transaction so it commits atomically with the source-message
   * lock. Once 'dispatching', a subsequent crash whose runtime state is lost is
   * treated as uncertain (never silently replayed).
   */
  async markThreadRunDispatching(executor: Knex | Knex.Transaction, dispatchId: string): Promise<void> {
    await executor('workspace_team_thread_runs').where({ id: dispatchId }).update({ dispatchPhase: 'dispatching', updatedAt: this.db.fn.now() });
  }

  async persistThreadRunManifest(dispatchId: string, patch: { contextCutoffSeq: number; contextManifest: Record<string, unknown>; policySnapshot: Record<string, unknown>; contextBuilderVersion: string }): Promise<void> {
    await this.db('workspace_team_thread_runs').where({ id: dispatchId }).update({
      contextCutoffSeq: patch.contextCutoffSeq,
      contextManifest: JSON.stringify(patch.contextManifest),
      policySnapshot: JSON.stringify(patch.policySnapshot),
      contextBuilderVersion: patch.contextBuilderVersion,
      updatedAt: this.db.fn.now(),
    });
  }

  async updateThreadRunStatus(dispatchId: string, patch: { status?: string; errorCode?: string | null; error?: string | null }): Promise<void> {
    await this.db('workspace_team_thread_runs').where({ id: dispatchId }).update({ ...patch, updatedAt: this.db.fn.now() });
  }

  // --- Release B: annotation/object thread links + anchors (F8) ----------

  /**
   * Workspace-audience collaboration objects linked to a thread (spec F8). Opens
   * the ORIGINAL object + its discussion; never copies replies. Reports the
   * original anchored excerpt/version and whether the anchored file has since
   * advanced past the anchor version (anchorChanged), for honest stale-anchor
   * handling. Authorized to the shared workspace; private objects are never
   * returned here.
   */
  async listThreadLinkedItems(workspaceId: string, threadId: string, userId: string): Promise<{ items: Array<Record<string, unknown>> }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');
    const rows = await this.db('workspace_collaboration_objects as o')
      .leftJoin('file_versions as av', 'av.id', 'o.anchorVersionId')
      // Resolve the CURRENT version by the object's canonical fileId, falling back
      // to the anchor version's fileId for legacy path-only records. This follows
      // the SAME file identity as the anchor — never the current path (which may
      // point at a different, recreated file after a delete+recreate).
      .leftJoin('files as f', 'f.id', this.db.raw('COALESCE(o."fileId", av."fileId")'))
      .where('o.workspaceId', workspaceId)
      .andWhere('o.sourceThreadId', threadId)
      .andWhere('o.visibility', 'workspace_audience')
      .orderBy([{ column: 'o.updatedAt', order: 'desc' }])
      .select(
        'o.id', 'o.type', 'o.status', 'o.title', 'o.filePath', 'o.anchorText',
        'o.anchorVersionId', 'o.createdAt',
        this.db.raw('COALESCE(o."fileId", av."fileId") as "fileId"'),
        'av.version as anchorVersionNumber',
        'f.version as currentVersionNumber',
        this.db.raw('(f."deletedAt" IS NOT NULL) as "fileDeleted"'),
      );
    return {
      items: rows.map((r: any) => ({
        objectId: r.id,
        type: r.type,
        status: r.status,
        title: r.title,
        fileId: r.fileId != null ? Number(r.fileId) : null,
        filePath: r.filePath,
        anchorText: r.anchorText,
        anchorVersionId: r.anchorVersionId,
        anchorVersionNumber: r.anchorVersionNumber ?? null,
        currentVersionNumber: r.currentVersionNumber ?? null,
        fileDeleted: Boolean(r.fileDeleted),
        // The anchored file advanced past the anchor version: the excerpt may no
        // longer map cleanly; the UI shows the ORIGINAL excerpt/version and offers
        // explicit reattachment. Never claims arbitrary-edit-stable anchors. A
        // deleted file is also surfaced as changed/unavailable.
        anchorChanged: (r.anchorVersionNumber != null && r.currentVersionNumber != null
          && Number(r.currentVersionNumber) > Number(r.anchorVersionNumber))
          || Boolean(r.fileDeleted),
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Re-pin an object's anchor to a NEW immutable file version (spec F8 explicit
   * reattachment). Validates the target version belongs to the object's OWN file
   * and workspace, and that any supplied offsets fit within the immutable bytes of
   * that version. Preserves the ORIGINAL anchor as an object event/message so the
   * only original reference is not blindly erased. Author or moderator only.
   */
  async reattachAnchor(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: { anchorVersionId: string; anchorStart?: number; anchorEnd?: number; anchorText?: string; blockId?: string; anchorFingerprint?: string },
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    const canModerate = canModerateWorkspaceCollaboration(access.membership.role);
    if (!canModerate && object.authorId !== userId) {
      throw new AccessDeniedError('Only the author or a Publisher can reattach an anchor');
    }
    if (object.visibility !== 'workspace_audience') {
      throw new ConflictError('Only shared objects have reattachable anchors');
    }
    // Reattachment requires an EXPLICIT new selection: a new excerpt AND its
    // offsets against the target version. A version-only request (no excerpt/
    // offsets) must NOT clear a stale anchor — the reviewer must re-select the
    // passage in the new version (spec F8: "request explicit reattachment").
    if (input.anchorText === undefined || input.anchorStart === undefined || input.anchorEnd === undefined) {
      throw new HttpError(400, 'Reattachment requires a new selected excerpt with start and end offsets');
    }
    // The target version must belong to THIS object's file in THIS workspace.
    const version = await this.db('file_versions').where({ id: input.anchorVersionId, workspaceId }).first();
    if (!version) throw new NotFoundError('Anchor version not found');
    if (object.fileId != null && Number(version.fileId) !== Number(object.fileId)) {
      throw new ConflictError('Anchor version does not belong to this object\'s file', { code: 'ANCHOR_VERSION_MISMATCH' });
    }
    // Verify the offsets fit AND the supplied excerpt actually matches the version
    // content at those offsets. Offsets are UTF-16 code-unit indices to match the
    // frontend DOM selection (String.slice semantics); we compare against the UTF-8
    // decoded text of the immutable version bytes. A mismatching excerpt/offset is
    // rejected so a new mutable selection is never paired with the wrong version.
    const bytes = await this.requireFileService().readImmutableVersionBytes(version);
    const text = bytes.toString('utf8');
    const start = input.anchorStart;
    const end = input.anchorEnd;
    if (start < 0 || end < start || end > text.length) {
      throw new HttpError(400, 'Anchor offsets do not fit the target version content');
    }
    if (text.slice(start, end) !== input.anchorText) {
      throw new ConflictError('The selected excerpt does not match the target version content at those offsets', { code: 'ANCHOR_EXCERPT_MISMATCH' });
    }
    // Preserve the ORIGINAL anchor as an object message so its only original
    // reference is not erased (honest reattachment history).
    await this.db.transaction(async (tx) => {
      await tx('workspace_collaboration_messages').insert({
        id: uuidv4(), objectId, authorId: userId,
        body: `Reattached anchor from version ${object.anchorVersionId || '(none)'} to ${version.id}. Original excerpt preserved: ${JSON.stringify({ anchorVersionId: object.anchorVersionId, anchorText: object.anchorText, anchorStart: object.anchorStart, anchorEnd: object.anchorEnd, blockId: object.blockId, anchorFingerprint: object.anchorFingerprint })}`,
      });
      await tx('workspace_collaboration_objects').where({ id: objectId }).update({
        anchorVersionId: version.id,
        anchorStart: input.anchorStart,
        anchorEnd: input.anchorEnd,
        anchorText: input.anchorText,
        ...(input.blockId !== undefined ? { blockId: this.optionalText(input.blockId) } : {}),
        ...(input.anchorFingerprint !== undefined ? { anchorFingerprint: this.optionalText(input.anchorFingerprint) } : {}),
        // Clear the stale marker only now that a valid new selection is pinned.
        ...(object.status === 'anchor_changed' ? { status: 'open' } : {}),
        updatedAt: tx.fn.now(),
      });
    });
    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, objectId, userId), userId);
  }

  /**
   * Resolve an explicit, version-pinned annotation reference for a Lumo run (spec
   * F8). The reference is `{ kind:'annotation', id, anchorVersionId? }`. Returns
   * the annotation's excerpt at its pinned/recorded anchor version — authorized
   * within the SAME workspace, workspace-audience only (a private annotation is
   * never resolvable here). This participates in the F3 budget/manifest as a
   * pinned reference; on retry it is reproduced from the recorded anchor version,
   * NOT re-fetched live. Linking alone never triggers this — it is only resolved
   * when the reference is explicitly included in an invocation.
   */
  async resolveAnnotationReference(
    workspaceId: string,
    userId: string,
    reference: { id: string; anchorVersionId?: string },
  ): Promise<{ objectId: string; anchorVersionId: string | null; excerpt: string; body: string; title: string | null; filePath: string | null }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const object = await this.db('workspace_collaboration_objects')
      .where({ id: reference.id, workspaceId })
      .first();
    if (!object) throw new NotFoundError('Annotation not found');
    if (object.visibility !== 'workspace_audience') {
      // A private annotation is never exposed to the agent via a team reference.
      throw new AccessDeniedError('This annotation is private and cannot be referenced');
    }
    // Freeze a CONSISTENT version + excerpt. If the reference explicitly requests a
    // specific anchor version, it must MATCH the object's CURRENT anchor version;
    // a stale request (e.g. an old version after a reattach) is rejected so we
    // never pair the new mutable selection text with an old version (reviewer
    // requirement). When no version is requested, we pin the object's current
    // recorded anchor version.
    const currentAnchorVersionId = object.anchorVersionId || null;
    if (reference.anchorVersionId) {
      const version = await this.db('file_versions').where({ id: reference.anchorVersionId, workspaceId }).first();
      if (!version) throw new NotFoundError('Referenced anchor version not found');
      if (object.fileId != null && Number(version.fileId) !== Number(object.fileId)) {
        throw new ConflictError('Referenced anchor version does not belong to the annotation file', { code: 'ANCHOR_VERSION_MISMATCH' });
      }
      if (currentAnchorVersionId && String(reference.anchorVersionId) !== String(currentAnchorVersionId)) {
        throw new ConflictError('The referenced annotation version is stale; re-reference the current anchor version', { code: 'ANNOTATION_REFERENCE_STALE', currentAnchorVersionId });
      }
    }
    // The excerpt + feedback body are the object's recorded immutable anchor text
    // and comment (the original selection + feedback), NOT a live re-read of
    // current document content. On retry the manifest reproduces this exact frozen
    // pair rather than re-fetching a possibly-edited annotation.
    return {
      objectId: object.id,
      anchorVersionId: currentAnchorVersionId,
      excerpt: String(object.anchorText || ''),
      body: String(object.body || ''),
      title: object.title || null,
      filePath: object.filePath || null,
    };
  }



  /**
   * Attributed history of file operations for a thread (or a single run). Returns
   * exact before/after version identity and flags whether a later version
   * superseded each one. Includes create/modify/rename/restore/delete.
   */
  async listThreadChanges(
    workspaceId: string,
    threadId: string,
    userId: string,
    options: { runId?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ changes: TeamThreadChangeRecord[]; nextCursor: string | null }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');
    const limit = Math.min(Math.max(options.limit || 50, 1), 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    // The cursor is scoped to workspace + thread + the active run filter. A cursor
    // minted under a runId filter must not be reused for the unfiltered list (or a
    // different run), otherwise keyset pagination could skip/duplicate rows across
    // a filter change.
    const cursorRunId = options.runId ?? null;
    if (cursor && (cursor.workspaceId !== workspaceId
      || cursor.threadId !== threadId
      || (cursor.runId ?? null) !== cursorRunId)) {
      throw new HttpError(400, 'Cursor does not match this changes list');
    }

    // Single query: self-join for the exact base version id, join current file
    // version. No per-row lookups (no N+1). Ordered by (createdAt, id) for a
    // stable opaque cursor. Deletions/restores are NOT filtered out.
    // Render createdAt as TEXT with full microsecond precision for BOTH the
    // returned cursor value and the keyset comparison. node-pg maps timestamptz
    // to a JS Date (millisecond precision only); using the Date in the cursor
    // truncates sub-millisecond timestamps and drops rows tied at the same
    // millisecond across pages (the same class of bug fixed for the thread list).
    // Render AT TIME ZONE 'UTC' so the literal "Z" label is truthful regardless of
    // the DATABASE session timezone (see listThreads for the full explanation of
    // the mislabeled-offset keyset bug this avoids).
    const CREATED_TEXT = `to_char(v."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await this.db('file_versions as v')
      .leftJoin('users as actor', 'actor.id', 'v.createdBy')
      .leftJoin('files as f', 'f.id', 'v.fileId')
      .leftJoin('file_versions as base', (join) => {
        join.on('base.fileId', 'v.fileId').andOn('base.version', 'v.baseVersion');
      })
      // Reconcile run-produced provenance: a version may have no direct
      // sourceThreadId (e.g. an agent run committed it, or a stamp was missed on a
      // worker restart) but its sourceRunId maps to a run that belongs to THIS
      // thread. Join the durable run mapping — SCOPED to this thread — so those
      // versions are attributed to the thread and its run status / source message
      // can be surfaced without ever pulling another thread's run (which would
      // leak a foreign sourceMessageId). Uses the unique runId; a version's
      // (fileId, version) is itself unique, so no duplicate history entries arise.
      .leftJoin('workspace_team_thread_runs as run', (join) => {
        join.on('run.runId', 'v.sourceRunId').andOn('run.threadId', this.db.raw('?', [threadId]));
      })
      .where('v.workspaceId', workspaceId)
      .andWhere((b) => {
        b.where('v.sourceThreadId', threadId)
          .orWhere((b2) => {
            // Reconciled: no direct thread stamp, but the (thread-scoped) run join
            // matched, so this version was produced by a run in THIS thread.
            b2.whereNull('v.sourceThreadId').whereNotNull('run.runId');
          });
      })
      .modify((q) => {
        if (options.runId) {
          // Run filter stays scoped to this thread: match the version's direct run
          // id AND require the thread-scoped run join to have matched, so a run id
          // from another thread returns nothing rather than leaking rows.
          q.andWhere('v.sourceRunId', options.runId).whereNotNull('run.runId');
        }
        if (cursor?.createdAt && cursor?.id) {
          q.whereRaw('(v."createdAt", v.id) < (?::timestamptz, ?)', [cursor.createdAt as string, cursor.id as string]);
        }
      })
      .orderBy([{ column: 'v.createdAt', order: 'desc' }, { column: 'v.id', order: 'desc' }])
      .limit(limit + 1)
      .select(
        'v.id', 'v.fileId', 'v.name', 'v.changeKind', 'v.version', 'v.baseVersion',
        'v.sourceRunId', 'v.createdBy', 'v.createdAt',
        this.db.raw(`${CREATED_TEXT} as "createdAtText"`),
        'f.version as currentVersion',
        this.db.raw('(f."deletedAt" IS NOT NULL) as "fileDeleted"'),
        'base.id as baseVersionId',
        // Alias via raw so the identifier is a proper quoted column alias (a plain
        // string alias containing quotes is emitted literally by Knex and yields a
        // null column). The reconciled run status lets the UI show that committed
        // work came from a FAILED run.
        this.db.raw('run.status as "runStatus"'),
        // Recovered provenance: a run-attributed version has no direct
        // sourceMessageId, so fall back to the reconciled run's source message
        // (already validated to belong to THIS thread via the join predicate).
        this.db.raw('COALESCE(v."sourceMessageId", run."sourceMessageId") as "sourceMessageId"'),
        this.db.raw(`COALESCE(actor."displayName", 'Former user') as "actorName"`),
      );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const changes: TeamThreadChangeRecord[] = page.map((v: any) => ({
      versionId: v.id,
      fileId: v.fileId,
      filePath: v.name, // historical name/path from the version record
      changeKind: v.changeKind,
      actorId: v.createdBy,
      actorName: v.actorName,
      createdAt: v.createdAt,
      sourceRunId: v.sourceRunId,
      sourceMessageId: v.sourceMessageId,
      baseVersionId: v.baseVersionId || null,
      baseVersion: v.baseVersion ?? null,
      version: v.version,
      currentVersion: v.currentVersion ?? null,
      // A later version exists — superseded — without claiming another thread's op.
      superseded: v.currentVersion != null && Number(v.currentVersion) > Number(v.version),
      // Originating run status (e.g. 'failed') when run-attributed, so the UI can
      // distinguish a committed file operation from a failed run.
      runStatus: v.runStatus || null,
      // The file is currently deleted; its immutable bytes remain retrievable via
      // the thread-scoped changes content endpoint.
      fileDeleted: Boolean(v.fileDeleted),
    }));
    const nextCursor = hasMore
      ? encodeCursor({ workspaceId, threadId, runId: cursorRunId, createdAt: page[page.length - 1].createdAtText, id: page[page.length - 1].id })
      : null;
    return { changes, nextCursor };
  }

  /**
   * Read the immutable bytes of a specific version that appears in a thread's
   * Changes view, for the diff/preview. Works EVEN FOR DELETED FILES: it reads
   * the immutable `file_versions` row by id (never the live `files` row, which is
   * filtered on deletedAt by the standard download path), scoped to the thread's
   * change set so a caller cannot read arbitrary versions. `side='after'` returns
   * this version's own bytes; `side='before'` returns its base version's bytes
   * (absent for a create). A `delete` change kind has no 'after' bytes (the
   * version is a tombstone recording the pre-delete content as its base). Never a
   * latest-content fallback — only the exact immutable snapshot.
   */
  async readThreadChangeVersionBytes(
    workspaceId: string,
    threadId: string,
    versionId: string,
    userId: string,
    side: 'before' | 'after',
  ): Promise<{ buffer: Buffer; mimeType: string; name: string; sizeBytes: number }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const thread = await this.db('workspace_team_threads').where({ id: threadId, workspaceId }).first();
    if (!thread) throw new NotFoundError('Thread not found');

    // The version must be part of THIS thread's change set: either directly
    // attributed (sourceThreadId) or reconciled through a run that belongs to the
    // thread. This authorizes the read without exposing arbitrary versions.
    const version = await this.db('file_versions as v')
      .leftJoin('workspace_team_thread_runs as run', (join) => {
        join.on('run.runId', 'v.sourceRunId').andOn('run.threadId', this.db.raw('?', [threadId]));
      })
      .where('v.id', versionId)
      .andWhere('v.workspaceId', workspaceId)
      .andWhere((b) => {
        b.where('v.sourceThreadId', threadId)
          .orWhere((b2) => b2.whereNull('v.sourceThreadId').whereNotNull('run.runId'));
      })
      .select('v.*')
      .first();
    if (!version) throw new NotFoundError('Change version not found for this thread');

    let target = version;
    if (side === 'before') {
      if (version.baseVersion == null) {
        // A create has no 'before' side.
        throw new NotFoundError('This change has no prior version');
      }
      const base = await this.db('file_versions')
        .where({ workspaceId, fileId: version.fileId, version: version.baseVersion })
        .first();
      if (!base) throw new NotFoundError('Prior version not found');
      target = base;
    } else if (version.changeKind === 'delete') {
      // A delete tombstone carries no distinct 'after' content; the pre-delete
      // bytes are its 'before' side.
      throw new NotFoundError('A deletion has no after content; request side=before');
    }

    const buffer = await this.requireFileService().readImmutableVersionBytes(target);
    return {
      buffer,
      mimeType: target.mimeType || 'application/octet-stream',
      name: String(target.name || ''),
      sizeBytes: Number(target.sizeBytes || buffer.length),
    };
  }

  /**
   * Spec F6 does NOT provide a retroactive "associate an existing version with a
   * thread" operation. Attribution is explicit and captured with EACH file
   * mutation (the client passes a validated `sourceThreadId` while a thread is
   * active; see FileService.commitFileBuffer/createFile/deleteFile/renameFile/
   * restoreFileVersion). Retroactively editing an old immutable version's
   * provenance would be an inference the spec forbids ("not retroactive inference
   * from timestamps"), so the former associateVersionWithThread method and its
   * route were removed. Future human association is the only supported path.
   */

  // --- Release B: frozen change-set submissions and review (F7) ----------

  /**
   * Pre-submit candidates (F7): server-derived files that differ between the
   * proposal's linked private copy and Shared Working, with rename pairs and
   * required asset-group keys. Author-only (the proposal owner submits from their
   * own private copy). Never trusts a client manifest.
   */
  async listSubmissionCandidates(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: { expectedSharedRevision: number },
  ): Promise<{ baseSharedRevision: number; basePrivateRevision: number; candidates: Array<Record<string, unknown>> }> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!getWorkspaceRoleCapabilities(access.membership.role).canPropose) {
      throw new AccessDeniedError('Contributor access is required to preview a submission');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.type !== 'change_proposal' || !object.linkedPrivateWorkspaceId) {
      throw new ConflictError('This proposal has no linked private working copy');
    }
    // Only the private-copy owner may enumerate its candidates.
    return this.publicationService.listSubmissionCandidates(
      object.linkedPrivateWorkspaceId, workspaceId, userId,
      { expectedSharedRevision: input.expectedSharedRevision },
    );
  }

  /**
   * List all submissions for a proposal (newest first) with their review history,
   * for the reviewer/author. Redacts the private workspace id and raw object
   * keys; exposes only opaque immutable ids necessary for review.
   */
  async listSubmissions(workspaceId: string, objectId: string, userId: string): Promise<{ submissions: Array<Record<string, unknown>> }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    await this.ensureObjectAccess(workspaceId, objectId, userId);
    const rows = await this.db('workspace_proposal_change_sets')
      .where({ objectId, workspaceId })
      .orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]);
    const submissionIds = rows.map((r: any) => r.id);
    const reviewRows = submissionIds.length
      ? await this.db('workspace_proposal_reviews')
        .whereIn('submissionId', submissionIds)
        .orderBy([{ column: 'createdAt', order: 'asc' }])
      : [];
    const reviewsBySubmission = new Map<string, any[]>();
    for (const rev of reviewRows) {
      const list = reviewsBySubmission.get(rev.submissionId) || [];
      list.push({ id: rev.id, reviewerId: rev.reviewerId, verdict: rev.verdict, comment: rev.comment, createdAt: rev.createdAt });
      reviewsBySubmission.set(rev.submissionId, list);
    }
    return {
      submissions: rows.map((r: any) => {
        const ops = typeof r.operations === 'string' ? JSON.parse(r.operations) : r.operations;
        return {
          id: r.id,
          status: r.status,
          submittedBy: r.submittedBy,
          publicExplanation: r.publicExplanation,
          baseSharedRevision: r.baseSharedRevision,
          operationCount: Array.isArray(ops) ? ops.length : 0,
          createdAt: r.createdAt,
          appliedAt: r.appliedAt || null,
          reviews: reviewsBySubmission.get(r.id) || [],
        };
      }),
    };
  }

  /**
   * Authenticated proposal-owned snapshot BYTES for a shared reviewer (F7). Scoped
   * by object + submission + operation index + side. Reads the frozen immutable
   * snapshot bytes (after) or the Shared base version bytes (before). Never
   * exposes a private/raw object key or the private workspace. Uses the SHARED
   * workspace scope for base reads so no private object is reachable.
   */
  async readSubmissionOperationBytes(
    workspaceId: string,
    objectId: string,
    submissionId: string,
    operationIndex: number,
    userId: string,
    side: 'before' | 'after',
  ): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    await this.ensureObjectAccess(workspaceId, objectId, userId);
    const row = await this.db('workspace_proposal_change_sets').where({ id: submissionId, objectId, workspaceId }).first();
    if (!row) throw new NotFoundError('Submission not found');
    const ops = typeof row.operations === 'string' ? JSON.parse(row.operations) : row.operations;
    if (!Array.isArray(ops) || operationIndex < 0 || operationIndex >= ops.length) {
      throw new NotFoundError('Operation not found in this submission');
    }
    return this.publicationService.readSubmissionOperationBytes(ops[operationIndex], side, workspaceId);
  }

  /**
   * Freeze an immutable submission manifest for a thread-linked proposal. The
   * server derives operations from the linked private copy vs the shared base;
   * it never trusts a client-supplied manifest. Subsequent private edits do not
   * alter this snapshot.
   */
  async submitProposalChangeSet(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: { expectedSharedRevision: number; expectedPrivateRevision: number; selectedOperations: Array<{ path: string; fileId?: number; changeKind?: string; fromPath?: string }>; publicExplanation?: string },
  ): Promise<ProposalChangeSet> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!getWorkspaceRoleCapabilities(access.membership.role).canPropose) {
      throw new AccessDeniedError('Contributor access is required to submit a change set');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.type !== 'change_proposal' || !object.linkedPrivateWorkspaceId) {
      throw new ConflictError('This proposal has no linked private working copy');
    }
    if (!input.selectedOperations.length) {
      throw new HttpError(400, 'Select at least one change to submit');
    }

    // Server derives the actual immutable versions/hashes for the selection from
    // the private copy; the client cannot widen or forge the selection. The id is
    // generated up front so proposal-owned snapshot objects key on it.
    const id = uuidv4();
    const derived = await this.publicationService.deriveSubmissionManifest(
      object.linkedPrivateWorkspaceId,
      workspaceId,
      userId,
      input.selectedOperations,
      { expectedSharedRevision: input.expectedSharedRevision, expectedPrivateRevision: input.expectedPrivateRevision, snapshotId: id },
    );

    await this.db.transaction(async (tx) => {
      // Lock the object row so a concurrent apply/submit is serialized.
      const locked = await tx('workspace_collaboration_objects').where({ id: objectId, workspaceId }).forUpdate().first();
      if (!locked) throw new NotFoundError('Collaboration item not found');
      await tx('workspace_proposal_change_sets').insert({
        id, workspaceId, objectId,
        sourceThreadId: (object as any).sourceThreadId || null,
        sourceMessageId: object.sourceTeamMessageId || null,
        privateWorkspaceId: object.linkedPrivateWorkspaceId,
        baseSharedRevision: derived.baseSharedRevision,
        basePrivateRevision: derived.basePrivateRevision,
        operations: JSON.stringify(derived.operations),
        publicExplanation: this.optionalText(input.publicExplanation),
        submittedBy: userId,
        status: 'submitted',
      });
      // A new snapshot preserves previous review history; point the object at it.
      await tx('workspace_collaboration_objects').where({ id: objectId }).update({
        submittedChangeSetId: id,
        submissionRevision: derived.baseSharedRevision,
        status: 'proposed',
        updatedAt: tx.fn.now(),
      });
    });
    return this.getSubmission(workspaceId, objectId, id, userId);
  }

  async getSubmission(workspaceId: string, objectId: string, submissionId: string, userId: string): Promise<ProposalChangeSet> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    await this.ensureObjectAccess(workspaceId, objectId, userId);
    const row = await this.db('workspace_proposal_change_sets').where({ id: submissionId, objectId, workspaceId }).first();
    if (!row) throw new NotFoundError('Submission not found');
    const rawOps = typeof row.operations === 'string' ? JSON.parse(row.operations) : row.operations;
    // Shared preview: expose only reviewable fields; never internal object keys,
    // provider versions, or the private workspace id.
    const operations = (rawOps as any[]).map((op) => ({
      path: op.path,
      fromPath: op.fromPath ?? null,
      fileId: op.fileId ?? null,
      changeKind: op.changeKind,
      baseVersionId: op.baseVersionId ?? null,
      proposedVersionId: op.proposedVersionId ?? null,
      sha256: op.sha256 ?? null,
    }));
    const reviewRows = await this.db('workspace_proposal_reviews')
      .where({ submissionId, objectId })
      .orderBy([{ column: 'createdAt', order: 'asc' }]);
    const reviews = reviewRows.map((rev: any) => ({
      id: rev.id, reviewerId: rev.reviewerId, verdict: rev.verdict, comment: rev.comment, createdAt: rev.createdAt,
    }));
    return {
      id: row.id,
      objectId: row.objectId,
      sourceThreadId: row.sourceThreadId,
      baseSharedRevision: row.baseSharedRevision,
      operations,
      publicExplanation: row.publicExplanation,
      submittedBy: row.submittedBy,
      status: row.status,
      createdAt: row.createdAt,
      reviews,
    };
  }

  async reviewSubmission(
    workspaceId: string,
    objectId: string,
    submissionId: string,
    userId: string,
    input: { verdict: 'approved' | 'changes_requested'; comment?: string },
  ): Promise<{ id: string; verdict: string }> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!getWorkspaceRoleCapabilities(access.membership.role).canComment) {
      throw new AccessDeniedError('Commenter access is required to review');
    }
    const submission = await this.db('workspace_proposal_change_sets').where({ id: submissionId, objectId, workspaceId }).first();
    if (!submission) throw new NotFoundError('Submission not found');
    const id = uuidv4();
    await this.db('workspace_proposal_reviews').insert({ id, submissionId, objectId, reviewerId: userId, verdict: input.verdict, comment: this.optionalText(input.comment) });
    return { id, verdict: input.verdict };
  }

  /**
   * Apply a frozen submission. Rechecks permission and the shared revision at
   * application time; if Shared Working moved, returns a typed conflict and does
   * not silently rebase. A submission may be applied only once.
   */
  async applySubmission(
    workspaceId: string,
    objectId: string,
    userId: string,
    input: { submissionId: string; expectedSharedRevision: number },
  ): Promise<WorkspaceCollaborationObject> {
    const access = await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    if (!canModerateWorkspaceCollaboration(access.membership.role)) {
      throw new AccessDeniedError('Owner or Publisher access is required to apply a proposal');
    }
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (object.type !== 'change_proposal') {
      throw new ConflictError('This collaboration item is not a change proposal');
    }
    const submission = await this.db('workspace_proposal_change_sets').where({ id: input.submissionId, objectId, workspaceId }).first();
    if (!submission) throw new NotFoundError('Submission not found');
    // Fast-fail on obviously stale/applied before doing work; the authoritative
    // checks are repeated under row locks inside the apply transaction.
    if (submission.status === 'applied') {
      throw new ConflictError('This submission was already applied', { code: 'SUBMISSION_ALREADY_APPLIED' });
    }
    if (Number(submission.baseSharedRevision) !== Number(input.expectedSharedRevision)) {
      throw new ConflictError('The submission base no longer matches the requested revision', { code: 'PROPOSAL_STALE', baseRevision: Number(submission.baseSharedRevision), currentRevision: Number(input.expectedSharedRevision) });
    }

    const operations = typeof submission.operations === 'string' ? JSON.parse(submission.operations) : submission.operations;
    // Apply frozen bytes (independent of the private workspace, which may have
    // been edited or deleted) AND persist the submission status/proposal decision
    // in ONE transaction via onApplied — which runs inside replaceWorkspaceContent's
    // afterDatabaseUpdate so a failure rolls back BOTH the SQL and the disk mirror.
    await this.publicationService.applySubmittedChangeSet(
      object.linkedPrivateWorkspaceId, // informational only; not required to exist
      workspaceId,
      userId,
      { submissionId: submission.id, baseSharedRevision: Number(submission.baseSharedRevision), operations },
      async (tx, appliedRevision) => {
        // Lock and recheck the object + submission inside the transaction so a
        // concurrent resubmit cannot replace the current submission mid-apply and
        // a superseded/duplicate submission cannot be applied.
        const lockedObject = await tx('workspace_collaboration_objects').where({ id: objectId, workspaceId }).forUpdate().first();
        if (!lockedObject) throw new NotFoundError('Collaboration item not found');
        if (String(lockedObject.submittedChangeSetId || '') !== String(submission.id)) {
          throw new ConflictError('This submission is not the current one for the proposal; resubmit or refresh', { code: 'SUBMISSION_SUPERSEDED' });
        }
        const updated = await tx('workspace_proposal_change_sets')
          .where({ id: submission.id, status: 'submitted' })
          .update({ status: 'applied', appliedSharedRevision: appliedRevision, appliedAt: tx.fn.now(), appliedBy: userId });
        if (!updated) throw new ConflictError('This submission was already applied', { code: 'SUBMISSION_ALREADY_APPLIED' });
        await tx('workspace_collaboration_objects').where({ id: objectId }).update({
          status: 'addressed', resolvedAt: tx.fn.now(), resolvedByVersionId: null, updatedAt: tx.fn.now(),
        });
        await tx('workspace_collaboration_messages').insert({
          id: uuidv4(), objectId, authorId: userId, body: `Applied submission to working revision ${appliedRevision}.`,
        });
      },
    );
    return this.redactObjectForViewer(await this.ensureObjectAccess(workspaceId, objectId, userId), userId);
  }

  /**
   * Author-only private navigation for a proposal (spec F7: "owner-only
   * navigation data can be returned separately after authorization"). Returns the
   * linked private workspace id + current revision ONLY to the object author, so
   * the redacted public object never leaks it while the author can still open
   * their Work-privately copy. Anyone else is denied.
   */
  async getProposalPrivateNavigation(workspaceId: string, objectId: string, userId: string): Promise<{ linkedPrivateWorkspaceId: string | null; privateContentRevision: number | null; sourceThreadId: string | null; originThreadIds: string[] }> {
    await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    const object = await this.ensureObjectAccess(workspaceId, objectId, userId);
    if (!object.linkedPrivateWorkspaceId) {
      throw new NotFoundError('This proposal has no linked private working copy');
    }
    // Verify the requester is the ACTUAL current owner of the linked private copy
    // (NOT merely the object author — another contributor may have converted it).
    // The private workspace must exist, be owned by the requester, and be linked to
    // this shared workspace for this user.
    const priv = await this.db('workspaces').where({ id: object.linkedPrivateWorkspaceId }).first();
    const link = await this.db('workspace_publication_links')
      .where({ privateWorkspaceId: object.linkedPrivateWorkspaceId, teamWorkspaceId: workspaceId, userId })
      .first();
    if (!priv || String(priv.ownerId) !== String(userId) || !link) {
      throw new AccessDeniedError('Only the private working copy owner can navigate it');
    }
    const originThreadIds = (await this.db('workspace_private_copy_origins')
      .where({ privateWorkspaceId: object.linkedPrivateWorkspaceId })
      .select('sourceThreadId')).map((o: any) => String(o.sourceThreadId));
    return {
      linkedPrivateWorkspaceId: object.linkedPrivateWorkspaceId,
      privateContentRevision: Number(priv.contentRevision || 0),
      sourceThreadId: (object as any).sourceThreadId || null,
      originThreadIds,
    };
  }

  /**
   * Lightweight current-authorization recheck for a pinned annotation reference on
   * retry/dispatch (spec F8: recheck current authorization without demanding the
   * current anchor still equals the old pinned version). Returns true only if the
   * requester currently has shared-workspace access AND the annotation still exists
   * as a workspace-audience object in this workspace. Does NOT re-resolve or
   * compare the pinned version — the frozen manifest content stays authoritative.
   */
  async isAnnotationReferenceAccessible(workspaceId: string, userId: string, objectId: string): Promise<boolean> {
    try {
      await this.ensureSharedWorkspaceAccess(workspaceId, userId);
    } catch {
      return false;
    }
    const object = await this.db('workspace_collaboration_objects')
      .where({ id: objectId, workspaceId })
      .first();
    return Boolean(object && object.visibility === 'workspace_audience');
  }

  private async ensureSharedWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<CollaborationAccess> {
    const access = await this.ensureCollaborationWorkspaceAccess(workspaceId, userId);
    if (!access.isShared) {
      throw new ConflictError('This collaboration feature is available only in Shared workspaces');
    }
    return access;
  }

  private async ensureCollaborationWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<CollaborationAccess> {
    // ensureMembership enforces the owner-only boundary for personal workspaces.
    const { workspace, membership } = await this.workspaceService.ensureMembership(workspaceId, userId);
    return {
      membership,
      currentPublishedVersionId: workspace.currentPublishedVersionId || null,
      isShared: workspace.visibility === 'team',
    };
  }

  /**
   * Redact private-navigation fields from a collaboration object before returning
   * it on any PUBLIC (shared-audience) response path. A shared viewer must never
   * see the author's `linkedPrivateWorkspaceId` — that exposes the existence/id of
   * the author's private copy (spec F7: "A shared proposal response must not
   * expose a private workspace ID or private transcript"). The object AUTHOR keeps
   * these fields so their own Work-privately navigation still works; everyone else
   * gets them nulled. The internal raw record (used for authorization/apply logic
   * via ensureObjectAccess) is never redacted — only this public projection is.
   */
  private redactObjectForViewer(object: WorkspaceCollaborationObject, _userId: string): WorkspaceCollaborationObject {
    // ALWAYS strip linkedPrivateWorkspaceId on public responses (including for the
    // object author) — the object author is NOT necessarily the private-copy owner
    // (another contributor may have converted it). Private navigation is served
    // only by getProposalPrivateNavigation, which verifies the ACTUAL private-copy
    // owner/access.
    return { ...object, linkedPrivateWorkspaceId: null };
  }

  /**
   * Resolve the immutable anchor version for a new object (spec F8). Resolves the
   * canonical file identity from fileId AND/OR filePath and rejects disagreeing
   * identities. If an explicit `anchorVersionId` is supplied, it MUST be a version
   * of that same canonical file (cross-file version UUIDs are rejected). Otherwise,
   * when a file anchor is present, pins the file's current immutable version.
   * Returns null when there is no file anchor at all.
   */
  private async resolveAnchorVersionForCreate(
    workspaceId: string,
    input: CreateWorkspaceCollaborationInput,
  ): Promise<{ fileId: number | null; anchorVersionId: string | null }> {
    // When an EXPLICIT immutable version is supplied (historical/published/renamed
    // selection), validate it against the version's OWN recorded identity — its
    // canonical fileId and its recorded historical name — NOT by re-resolving the
    // supplied path to whatever file currently occupies it. This lets an old
    // published-path version anchor correctly even after that path was renamed
    // away and a NEW file was created at the same path, while still rejecting a
    // version from an unrelated file (whether or not the supplied path exists).
    if (input.anchorVersionId) {
      const version = await this.db('file_versions').where({ id: input.anchorVersionId, workspaceId }).first();
      if (!version) throw new NotFoundError('Anchor version not found');
      // An explicit fileId must equal the version's canonical fileId.
      if (input.fileId && Number(version.fileId) !== Number(input.fileId)) {
        throw new ConflictError('Anchor version does not belong to the annotated file', { code: 'ANCHOR_VERSION_MISMATCH' });
      }
      if (input.filePath) {
        const normalized = input.filePath.replace(/^\/+/, '');
        // The supplied path must identify THIS version's file — either by the
        // version's recorded historical name (the name at the time of the version)
        // OR by the file's CURRENT name (the same canonical file, possibly since
        // renamed). We look the current name up BY the version's fileId, never by
        // the supplied path (which could point at a different recreated file).
        const versionName = String(version.name || '').replace(/^\/+/, '');
        const currentFile = await this.db('files').where({ id: version.fileId, workspaceId }).first();
        const currentName = currentFile ? String(currentFile.name || '').replace(/^\/+/, '') : null;
        if (normalized !== versionName && normalized !== currentName) {
          throw new ConflictError('Anchor version does not belong to the annotated file path', { code: 'ANCHOR_FILE_MISMATCH' });
        }
      }
      return { fileId: Number(version.fileId), anchorVersionId: String(version.id) };
    }
    // No explicit version: resolve the canonical file from fileId and/or filePath
    // and pin its CURRENT immutable version (a live selection on current content).
    let file: any = null;
    if (input.fileId) {
      file = await this.db('files').where({ id: input.fileId, workspaceId }).first();
      if (!file) throw new NotFoundError('Annotated file not found');
    }
    if (input.filePath) {
      const normalized = input.filePath.replace(/^\/+/, '');
      const byPath = await this.db('files').where({ workspaceId, name: normalized }).whereNull('deletedAt').first();
      if (file && byPath && Number(byPath.id) !== Number(file.id)) {
        throw new ConflictError('filePath and fileId identify different files', { code: 'ANCHOR_FILE_MISMATCH' });
      }
      if (!file) file = byPath;
    }
    if (file) {
      return { fileId: Number(file.id), anchorVersionId: file.currentVersionId ? String(file.currentVersionId) : null };
    }
    return { fileId: null, anchorVersionId: null };
  }

  private async ensureObjectAccess(
    workspaceId: string,
    objectId: string,
    userId: string,
    personalOnly = false,
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
    if ((personalOnly && (object.type !== 'annotation' || object.visibility !== 'private'))
      || (object.visibility === 'private' && object.authorId !== userId)) {
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
      throw new NotFoundError('Workspace Chat message not found');
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
