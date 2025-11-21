import knex, { Knex } from 'knex';

type PgConnection = Knex.PgConnectionConfig | string | Knex.StaticConnectionConfig;

export class DatabaseService {
  private db: Knex;

  constructor() {
    this.db = knex({
      client: 'pg',
      connection: this.buildConnectionConfig(),
      pool: {
        min: Number(process.env.DB_POOL_MIN ?? 0),
        max: Number(process.env.DB_POOL_MAX ?? 10),
      },
    });
  }

  public getDb(): Knex {
    return this.db;
  }

  public async initialize(): Promise<void> {
    await this.createUsersTable();
    await this.createWorkspacesTable();
    await this.createWorkspaceMembersTable();
    await this.createFilesTable();
    await this.createConversationsTable();
    await this.createConversationMessagesTable();
  }

  private buildConnectionConfig(): PgConnection {
    const ssl = this.buildSSLConfig();
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      if (ssl) {
        return {
          connectionString,
          ssl,
        };
      }
      return connectionString;
    }

    const config: Knex.PgConnectionConfig = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT || 5432),
      database: process.env.POSTGRES_DB || 'helpudoc',
      user: process.env.POSTGRES_USER || 'helpudoc',
      password: process.env.POSTGRES_PASSWORD || 'helpudoc',
    };

    if (ssl) {
      config.ssl = ssl;
    }

    return config;
  }

  private buildSSLConfig(): false | { rejectUnauthorized: boolean } {
    const raw = (process.env.DATABASE_SSL || '').toLowerCase();
    if (!raw || raw === 'false' || raw === '0') {
      return false;
    }
    if (raw === 'strict') {
      return { rejectUnauthorized: true };
    }
    if (raw === 'allow' || raw === 'skip-verify') {
      return { rejectUnauthorized: false };
    }
    return { rejectUnauthorized: true };
  }

  private async createUsersTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('users');
    if (!exists) {
      await this.db.schema.createTable('users', (table) => {
        table.uuid('id').primary();
        table.string('externalId').notNullable().unique();
        table.string('email');
        table.string('displayName').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "users" table.');
    }
  }

  private async createWorkspacesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspaces');
    if (!exists) {
      await this.db.schema.createTable('workspaces', (table) => {
        table.uuid('id').primary();
        table.string('name').notNullable();
        table.string('slug').notNullable().unique();
        table.uuid('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('lastModifiedBy').references('id').inTable('users');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "workspaces" table.');
    } else {
      await this.ensureColumn('workspaces', 'slug', (table) => table.string('slug').notNullable().defaultTo(this.db.raw('md5(random()::text)')));
      await this.ensureColumn('workspaces', 'ownerId', (table) => table.uuid('ownerId'));
      await this.ensureColumn('workspaces', 'lastModifiedBy', (table) => table.uuid('lastModifiedBy'));
    }
  }

  private async createWorkspaceMembersTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_members');
    if (!exists) {
      await this.db.schema.createTable('workspace_members', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('role', 32).notNullable();
        table.boolean('canEdit').notNullable().defaultTo(true);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'userId']);
      });
      console.log('Created "workspace_members" table.');
    } else {
      await this.ensureColumn('workspace_members', 'role', (table) => table.string('role', 32).notNullable().defaultTo('editor'));
      await this.ensureColumn('workspace_members', 'canEdit', (table) => table.boolean('canEdit').notNullable().defaultTo(true));
    }
  }

  private async createFilesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('files');
    if (!exists) {
      await this.db.schema.createTable('files', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.string('storageType', 16).notNullable();
        table.string('path').notNullable();
        table.string('mimeType');
        table.string('publicUrl');
        table.uuid('createdBy').references('id').inTable('users');
        table.uuid('updatedBy').references('id').inTable('users');
        table.integer('version').notNullable().defaultTo(1);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['workspaceId', 'name']);
        table.index(['workspaceId', 'updatedAt'], 'files_workspace_updated_idx');
      });
      console.log('Created "files" table.');
    } else {
      await this.ensureFilesTableColumns();
    }
  }

  private async createConversationsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('conversations');
    if (!exists) {
      await this.db.schema.createTable('conversations', (table) => {
        table.uuid('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.string('persona').notNullable();
        table.string('title').notNullable().defaultTo('New Conversation');
        table.uuid('createdBy').references('id').inTable('users');
        table.uuid('updatedBy').references('id').inTable('users');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['workspaceId', 'updatedAt'], 'conversations_workspace_updated_idx');
      });
      console.log('Created "conversations" table.');
    } else {
      await this.ensureColumn('conversations', 'createdBy', (table) => table.uuid('createdBy'));
      await this.ensureColumn('conversations', 'updatedBy', (table) => table.uuid('updatedBy'));
    }
  }

  private async createConversationMessagesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('conversation_messages');
    if (!exists) {
      await this.db.schema.createTable('conversation_messages', (table) => {
        table.increments('id').primary();
        table.uuid('conversationId').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
        table.string('sender', 16).notNullable();
        table.uuid('authorId').references('id').inTable('users');
        table.text('text').notNullable();
        table.string('turnId');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['conversationId', 'createdAt'], 'conversation_messages_conversation_created_idx');
        table.index(['conversationId', 'turnId'], 'conversation_messages_turn_idx');
      });
      console.log('Created "conversation_messages" table.');
    } else {
      await this.ensureConversationMessagesColumns();
    }
  }

  private async ensureFilesTableColumns(): Promise<void> {
    await this.ensureColumn('files', 'mimeType', (table) => table.string('mimeType'));
    await this.ensureColumn('files', 'publicUrl', (table) => table.string('publicUrl'));
    await this.ensureColumn('files', 'createdBy', (table) => table.uuid('createdBy'));
    await this.ensureColumn('files', 'updatedBy', (table) => table.uuid('updatedBy'));
    await this.ensureColumn('files', 'version', (table) => table.integer('version').notNullable().defaultTo(1));
  }

  private async ensureConversationMessagesColumns(): Promise<void> {
    await this.ensureColumn('conversation_messages', 'turnId', (table) => table.string('turnId'));
    await this.ensureColumn('conversation_messages', 'updatedAt', (table) => table.timestamp('updatedAt'));
    await this.ensureColumn('conversation_messages', 'authorId', (table) => table.uuid('authorId'));
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS conversation_messages_turn_idx ON conversation_messages ("conversationId", "turnId")'
    );
  }

  private async ensureColumn(
    tableName: string,
    columnName: string,
    definition: (table: Knex.AlterTableBuilder) => void,
  ): Promise<void> {
    const hasColumn = await this.db.schema.hasColumn(tableName, columnName);
    if (!hasColumn) {
      await this.db.schema.alterTable(tableName, (table) => {
        definition(table);
      });
      console.log(`Added column "${columnName}" to "${tableName}" table.`);
    }
  }
}
