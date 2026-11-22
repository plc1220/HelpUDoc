import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { NotFoundError } from '../errors';
import type { ConversationArchiveSourceRow, StoredConversationSummary } from './conversationCompaction';
import { capToolEventsInMetadata } from '../lib/toolEventSummary';

export type ConversationSender = 'user' | 'agent';

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  persona: string;
  title: string;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  id: number;
  conversationId: string;
  sender: ConversationSender;
  text: string;
  createdAt: string;
  updatedAt: string;
  turnId?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AppendMessageOptions {
  turnId?: string;
  replaceExisting?: boolean;
  metadata?: Record<string, unknown>;
}

interface EnsureConversationAccessOptions {
  requireEdit?: boolean;
}

const metadataString = (metadata: unknown, key: string): string => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const shouldPreserveRunOwnedAssistantBody = (
  existingText: string,
  incomingText: string,
  existingMetadata?: Record<string, unknown> | null,
  incomingMetadata?: Record<string, unknown> | null,
): boolean => {
  const existingRunId = metadataString(existingMetadata, 'runId');
  const incomingRunId = metadataString(incomingMetadata, 'runId');
  return Boolean(
    existingText
    && incomingText
    && existingRunId
    && existingRunId === incomingRunId
    && metadataString(existingMetadata, 'bodySource') === 'assistant'
    && metadataString(incomingMetadata, 'bodySource') === 'summary'
  );
};

export const mergeRunOwnedAgentText = (
  existingText: string,
  incomingText: string,
  existingMetadata?: Record<string, unknown> | null,
  incomingMetadata?: Record<string, unknown> | null,
): string => {
  const existingRunId = metadataString(existingMetadata, 'runId');
  const incomingRunId = metadataString(incomingMetadata, 'runId');
  if (!existingRunId || existingRunId !== incomingRunId || !existingText || !incomingText) {
    return incomingText;
  }
  // Recovery may observe a terminal Redis event while the normal worker is
  // still settling. Its synthetic summary must never replace assistant text
  // already persisted for the same run.
  if (shouldPreserveRunOwnedAssistantBody(existingText, incomingText, existingMetadata, incomingMetadata)) {
    return existingText;
  }
  if (incomingText.startsWith(existingText)) {
    return incomingText;
  }
  if (existingText.startsWith(incomingText) || existingText.endsWith(incomingText)) {
    return existingText;
  }
  return incomingText;
};

export const mergeRunOwnedAgentMetadata = (
  existingText: string,
  incomingText: string,
  existingMetadata?: Record<string, unknown> | null,
  incomingMetadata?: Record<string, unknown> | null,
): Record<string, unknown> | null | undefined => {
  const existingRunId = metadataString(existingMetadata, 'runId');
  const incomingRunId = metadataString(incomingMetadata, 'runId');
  if (!existingRunId || existingRunId !== incomingRunId || !incomingMetadata) {
    return incomingMetadata;
  }
  const mergedMetadata: Record<string, unknown> = {
    ...incomingMetadata,
  };
  // Recovery snapshots may be intentionally sparse. Preserve durable activity
  // captured by the live worker unless recovery reconstructed a replacement.
  for (const key of ['thinkingText', 'toolEvents', 'progressEvents', 'workflowActions', 'runPolicy']) {
    if (mergedMetadata[key] === undefined && existingMetadata?.[key] !== undefined) {
      mergedMetadata[key] = existingMetadata[key];
    }
  }
  if (shouldPreserveRunOwnedAssistantBody(existingText, incomingText, existingMetadata, incomingMetadata)) {
    mergedMetadata.bodySource = 'assistant';
  }
  return mergedMetadata;
};

export class ConversationService {
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  async createConversation(userId: string, workspaceId: string, persona: string): Promise<ConversationRecord> {
    const { workspace } = await this.workspaceService.ensureMembership(workspaceId, userId);
    const [conversation] = await this.db('conversations')
      .insert({
        id: uuidv4(),
        workspaceId,
        persona,
        title: 'New Conversation',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning('*');

    if (workspace.visibility === 'private') {
      await this.workspaceService.touchWorkspace(workspaceId, userId);
    }

    return conversation as ConversationRecord;
  }

  async listRecentConversations(userId: string, workspaceId: string, limit = 5): Promise<ConversationRecord[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const conversations = await this.db('conversations')
      .where({ workspaceId, createdBy: userId })
      .orderBy('updatedAt', 'desc')
      .limit(limit);

    return conversations as ConversationRecord[];
  }

  async getConversationWithMessages(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationRecord; messages: ConversationMessageRecord[] } | null> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      return null;
    }

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId);
    if (conversation.createdBy && conversation.createdBy !== userId) {
      return null;
    }

    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');

    return {
      conversation: conversation as ConversationRecord,
      // Rows written before tool output was capped can hold megabytes per message.
      messages: (messages as ConversationMessageRecord[]).map((message) => {
        const metadata = capToolEventsInMetadata(message.metadata);
        return metadata === message.metadata ? message : { ...message, metadata };
      }),
    };
  }

  async ensureConversationAccess(
    userId: string,
    workspaceId: string,
    conversationId: string,
    options: EnsureConversationAccessOptions = {},
  ): Promise<ConversationRecord> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation || conversation.workspaceId !== workspaceId) {
      throw new NotFoundError('Conversation not found');
    }

    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: options.requireEdit,
    });
    if (conversation.createdBy && conversation.createdBy !== userId) {
      throw new NotFoundError('Conversation not found');
    }
    return conversation as ConversationRecord;
  }

  async appendMessage(
    userId: string,
    conversationId: string,
    sender: ConversationSender,
    text: string,
    options: AppendMessageOptions = {}
  ): Promise<ConversationMessageRecord> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId);
    if (conversation.createdBy && conversation.createdBy !== userId) {
      throw new NotFoundError('Conversation not found');
    }

    const turnId = options.turnId || (sender === 'user' ? uuidv4() : undefined);
    const timestamp = this.db.fn.now();

    if (options.replaceExisting && turnId) {
      const existing = await this.db('conversation_messages')
        .where({ conversationId, sender, turnId })
        .first();
      if (existing) {
        const nextText = sender === 'agent'
          ? mergeRunOwnedAgentText(existing.text || '', text, existing.metadata, options.metadata)
          : text;
        const nextMetadata = sender === 'agent'
          ? mergeRunOwnedAgentMetadata(existing.text || '', text, existing.metadata, options.metadata)
          : options.metadata;
        const updatePayload: Record<string, unknown> = {
          text: nextText,
          updatedAt: timestamp,
          authorId: sender === 'user' ? userId : existing.authorId,
        };
        if (nextMetadata !== undefined) {
          updatePayload.metadata = capToolEventsInMetadata(nextMetadata);
        }
        const [updated] = await this.db('conversation_messages')
          .where({ id: existing.id })
          .update(updatePayload)
          .returning('*');
        await this.updateConversationMetadata(conversation, sender, nextText, userId);
        return updated as ConversationMessageRecord;
      }
    }

    const insertPayload: Record<string, unknown> = {
      conversationId,
      sender,
      text,
      updatedAt: timestamp,
      authorId: sender === 'user' ? userId : null,
    };

    if (turnId) {
      insertPayload.turnId = turnId;
    }
    if (options.metadata !== undefined) {
      insertPayload.metadata = capToolEventsInMetadata(options.metadata);
    }

    const [message] = await this.db('conversation_messages').insert(insertPayload).returning('*');

    await this.updateConversationMetadata(conversation, sender, text, userId);

    return message as ConversationMessageRecord;
  }

  /**
   * Text of a conversation's messages for the agent's run archive. Same access rules as
   * getConversationWithMessages: the user must be a workspace member AND the
   * conversation's creator. Returns null otherwise; never another user's conversation.
   */
  async listConversationArchiveSource(
    userId: string,
    conversationId: string,
  ): Promise<ConversationArchiveSourceRow[] | null> {
    if (!userId || !conversationId) {
      return null;
    }
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      return null;
    }
    await this.workspaceService.ensureMembership(conversation.workspaceId, userId);
    if (conversation.createdBy !== userId) {
      return null;
    }
    return this.db('conversation_messages')
      .where({ conversationId })
      .orderBy([{ column: 'createdAt', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('id', 'sender', 'text', 'createdAt', this.db.raw(`metadata->>'bodySource' as "bodySource"`));
  }

  // Storage for conversationCompaction.ts. No access check: callers have already checked
  // the user's access to the conversation, and nothing here is returned to a client.
  async getConversationSummary(conversationId: string): Promise<StoredConversationSummary | null> {
    const row = await this.db('conversation_summaries').where({ conversationId }).first();
    if (!row) {
      return null;
    }
    return {
      summary: String(row.summary || ''),
      coveredCount: Number(row.coveredCount) || 0,
      coveredHash: String(row.coveredHash || ''),
      version: Number(row.version) || 0,
    };
  }

  async saveConversationSummary(
    conversationId: string,
    expectedVersion: number | null,
    value: { summary: string; coveredCount: number; coveredHash: string; coveredTokens: number },
  ): Promise<boolean> {
    if (expectedVersion === null) {
      const inserted = await this.db('conversation_summaries')
        .insert({ conversationId, ...value, version: 1 })
        .onConflict('conversationId')
        .ignore()
        .returning('conversationId');
      return inserted.length > 0;
    }
    // Compare-and-set: a concurrent job that saved first wins, and this result is dropped.
    const updated = await this.db('conversation_summaries')
      .where({ conversationId, version: expectedVersion })
      .update({ ...value, version: expectedVersion + 1, updatedAt: this.db.fn.now() });
    return updated > 0;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      return false;
    }

    const { workspace } = await this.workspaceService.ensureMembership(conversation.workspaceId, userId);
    if (conversation.createdBy && conversation.createdBy !== userId) {
      throw new NotFoundError('Conversation not found');
    }

    const deleted = await this.db('conversations').where({ id: conversationId }).del();
    if (deleted) {
      if (workspace.visibility === 'private') {
        await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);
      }
    }
    return deleted > 0;
  }

  async truncateConversationAfterMessage(
    userId: string,
    conversationId: string,
    messageId: number,
  ): Promise<number> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    const { workspace } = await this.workspaceService.ensureMembership(conversation.workspaceId, userId);
    if (conversation.createdBy && conversation.createdBy !== userId) {
      throw new NotFoundError('Conversation not found');
    }

    const targetMessage = await this.db('conversation_messages')
      .where({ id: messageId, conversationId })
      .first();
    if (!targetMessage) {
      throw new NotFoundError('Message not found');
    }

    const deleted = await this.db('conversation_messages')
      .where({ conversationId })
      .andWhere('id', '>', messageId)
      .del();

    await this.db('conversations')
      .where({ id: conversationId })
      .update({ updatedAt: this.db.fn.now(), updatedBy: userId });
    if (workspace.visibility === 'private') {
      await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);
    }

    return deleted;
  }

  private needsTitleUpdate(existingTitle: string | null | undefined): boolean {
    if (!existingTitle) {
      return true;
    }
    return existingTitle === 'New Conversation';
  }

  private async updateConversationMetadata(
    conversation: ConversationRecord,
    sender: ConversationSender,
    text: string,
    userId: string,
  ): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      updatedAt: this.db.fn.now(),
      updatedBy: userId,
    };

    if (sender === 'user' && this.needsTitleUpdate(conversation.title)) {
      updatePayload.title = this.buildConversationTitle(text);
    }

    await this.db('conversations').where({ id: conversation.id }).update(updatePayload);
    const workspace = await this.db('workspaces')
      .select('visibility')
      .where({ id: conversation.workspaceId })
      .first();
    if (workspace?.visibility === 'private') {
      await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);
    }
  }

  private buildConversationTitle(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return 'Conversation';
    }
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
  }
}
