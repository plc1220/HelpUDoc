import knex, { Knex } from 'knex';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'workspaces.db');

export class DatabaseService {
  private db: Knex;

  constructor() {
    this.db = knex({
      client: 'sqlite3',
      connection: {
        filename: DB_PATH,
      },
      useNullAsDefault: true,
    });
  }

  public async initialize(): Promise<void> {
    await this.createWorkspacesTable();
    await this.createFilesTable();
    await this.createConversationsTable();
    await this.createConversationMessagesTable();
  }

  private async createWorkspacesTable(): Promise<void> {
    const tableExists = await this.db.schema.hasTable('workspaces');
    if (!tableExists) {
      await this.db.schema.createTable('workspaces', (table) => {
        table.string('id').primary();
        table.string('name').notNullable();
        table.timestamps(true, true);
      });
      console.log('Created "workspaces" table.');
    }
  }

  private async createFilesTable(): Promise<void> {
    const tableExists = await this.db.schema.hasTable('files');
    if (!tableExists) {
      await this.db.schema.createTable('files', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.string('workspaceId').references('id').inTable('workspaces').onDelete('CASCADE');
        table.enum('storageType', ['local', 's3']).notNullable();
        table.string('path').notNullable(); // Local path or S3 key
        table.timestamps(true, true);
      });
      console.log('Created "files" table.');
    }
  }

  private async createConversationsTable(): Promise<void> {
    const db = this.db;
    const tableExists = await db.schema.hasTable('conversations');
    if (!tableExists) {
      await db.schema.createTable('conversations', (table) => {
        table.string('id').primary();
        table.string('workspaceId').notNullable();
        table.string('persona').notNullable();
        table.string('title').notNullable().defaultTo('New Conversation');
        table.timestamp('createdAt').notNullable().defaultTo(db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(db.fn.now());
        table.index(['workspaceId', 'updatedAt'], 'conversations_workspace_updated_idx');
      });
      console.log('Created "conversations" table.');
    }
  }

  private async createConversationMessagesTable(): Promise<void> {
    const db = this.db;
    const tableExists = await db.schema.hasTable('conversation_messages');
    if (!tableExists) {
      await db.schema.createTable('conversation_messages', (table) => {
        table.increments('id').primary();
        table.string('conversationId').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
        table.enum('sender', ['user', 'agent']).notNullable();
        table.text('text').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(db.fn.now());
        table.index(['conversationId', 'createdAt'], 'conversation_messages_conversation_created_idx');
      });
      console.log('Created "conversation_messages" table.');
    }
  }

  public getDb(): Knex {
    return this.db;
  }
  public async deleteWorkspace(id: string): Promise<void> {
    await this.db('workspaces').where({ id }).del();
  }
}
