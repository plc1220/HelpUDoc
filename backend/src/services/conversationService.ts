import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { NotFoundError } from '../errors';

export type ConversationSender = 'user' | 'agent';

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  persona: string;
  title: string;
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
  if (incomingText.startsWith(existingText)) {
    return incomingText;
  }
  if (existingText.startsWith(incomingText) || existingText.endsWith(incomingText)) {
    return existingText;
  }
  return incomingText;
};

export class ConversationService {
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  async createConversation(userId: string, workspaceId: string, persona: string): Promise<ConversationRecord> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
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

    await this.workspaceService.touchWorkspace(workspaceId, userId);

    return conversation as ConversationRecord;
  }

  async listRecentConversations(userId: string, workspaceId: string, limit = 5): Promise<ConversationRecord[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const conversations = await this.db('conversations')
      .where({ workspaceId })
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

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId, { requireEdit: true });

    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');

    return {
      conversation: conversation as ConversationRecord,
      messages: messages as ConversationMessageRecord[],
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

    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
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

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId, { requireEdit: true });

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
        const updatePayload: Record<string, unknown> = {
          text: nextText,
          updatedAt: timestamp,
          authorId: sender === 'user' ? userId : existing.authorId,
        };
        if (options.metadata !== undefined) {
          updatePayload.metadata = options.metadata;
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
      insertPayload.metadata = options.metadata;
    }

    const [message] = await this.db('conversation_messages').insert(insertPayload).returning('*');

    await this.updateConversationMetadata(conversation, sender, text, userId);

    return message as ConversationMessageRecord;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      return false;
    }

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId, { requireEdit: true });

    const deleted = await this.db('conversations').where({ id: conversationId }).del();
    if (deleted) {
      await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);
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

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId, { requireEdit: true });

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
    await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);

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
    await this.workspaceService.touchWorkspace(conversation.workspaceId, userId);
  }

  private buildConversationTitle(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return 'Conversation';
    }
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
  }
}
