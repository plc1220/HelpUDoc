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

export class ConversationService {
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  async createConversation(userId: string, workspaceId: string, persona: string): Promise<ConversationRecord> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
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
    await this.workspaceService.ensureMembership(workspaceId, userId);
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

    await this.workspaceService.ensureMembership(conversation.workspaceId, userId);

    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');

    return {
      conversation: conversation as ConversationRecord,
      messages: messages as ConversationMessageRecord[],
    };
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
        const updatePayload: Record<string, unknown> = {
          text,
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
        await this.updateConversationMetadata(conversation, sender, text, userId);
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
