import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';

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
}

export class ConversationService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async createConversation(workspaceId: string, persona: string): Promise<ConversationRecord> {
    const [conversation] = await this.db('conversations')
      .insert({
        id: uuidv4(),
        workspaceId,
        persona,
        title: 'New Conversation',
      })
      .returning('*');

    return conversation as ConversationRecord;
  }

  async listRecentConversations(workspaceId: string, limit = 5): Promise<ConversationRecord[]> {
    const conversations = await this.db('conversations')
      .where({ workspaceId })
      .orderBy('updatedAt', 'desc')
      .limit(limit);

    return conversations as ConversationRecord[];
  }

  async getConversationWithMessages(conversationId: string): Promise<{ conversation: ConversationRecord; messages: ConversationMessageRecord[] } | null> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      return null;
    }

    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');

    return {
      conversation: conversation as ConversationRecord,
      messages: messages as ConversationMessageRecord[],
    };
  }

  async appendMessage(conversationId: string, sender: ConversationSender, text: string): Promise<ConversationMessageRecord> {
    const conversation = await this.db('conversations').where({ id: conversationId }).first();
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const [message] = await this.db('conversation_messages')
      .insert({
        conversationId,
        sender,
        text,
      })
      .returning('*');

    const updatePayload: Record<string, unknown> = {
      updatedAt: this.db.fn.now(),
    };

    if (sender === 'user' && this.needsTitleUpdate(conversation.title)) {
      updatePayload.title = this.buildConversationTitle(text);
    }

    await this.db('conversations').where({ id: conversationId }).update(updatePayload);

    return message as ConversationMessageRecord;
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    const deleted = await this.db('conversations').where({ id: conversationId }).del();
    return deleted > 0;
  }

  private needsTitleUpdate(existingTitle: string | null | undefined): boolean {
    if (!existingTitle) {
      return true;
    }
    return existingTitle === 'New Conversation';
  }

  private buildConversationTitle(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return 'Conversation';
    }
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
  }
}
