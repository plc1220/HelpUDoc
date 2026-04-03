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
    await this.createUserOAuthTokensTable();
    await this.createGroupsTable();
    await this.createGroupMembersTable();
    await this.createSkillGrantsTable();
    await this.createMcpServerGroupGrantsTable();
    await this.createWorkspacesTable();
    await this.createWorkspaceMembersTable();
    await this.createMcpServerGrantsTable();
    await this.createMcpConnectionsTable();
    await this.createMcpConnectionGrantsTable();
    await this.createFilesTable();
    await this.createCollabDocumentsTable();
    await this.createKnowledgeSourcesTable();
    await this.createConversationsTable();
    await this.createConversationMessagesTable();
    await this.createAgentRunSummariesTable();
    await this.createAgentRunToolEventsTable();
    await this.createAgentDailyReflectionsTable();
    await this.createAgentDailyReflectionBreakdownsTable();
    await this.createUserMemorySuggestionsTable();
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
        table.boolean('isAdmin').notNullable().defaultTo(false);
        table.string('oidcIssuer');
        table.string('oidcSubject');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "users" table.');
    } else {
      await this.ensureColumn('users', 'isAdmin', (table) => table.boolean('isAdmin').notNullable().defaultTo(false));
      await this.ensureColumn('users', 'oidcIssuer', (table) => table.string('oidcIssuer'));
      await this.ensureColumn('users', 'oidcSubject', (table) => table.string('oidcSubject'));
    }
  }

  private async createGroupsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('groups');
    if (!exists) {
      await this.db.schema.createTable('groups', (table) => {
        table.uuid('id').primary();
        table.string('name').notNullable().unique();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "groups" table.');
    }
  }

  private async createUserOAuthTokensTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('user_oauth_tokens');
    if (!exists) {
      await this.db.schema.createTable('user_oauth_tokens', (table) => {
        table.bigIncrements('id').primary();
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('provider', 64).notNullable();
        table.text('encryptedJson').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['userId', 'provider']);
      });
      console.log('Created "user_oauth_tokens" table.');
    } else {
      await this.ensureColumn('user_oauth_tokens', 'provider', (table) => table.string('provider', 64).notNullable().defaultTo('google'));
      await this.ensureColumn('user_oauth_tokens', 'encryptedJson', (table) => table.text('encryptedJson').notNullable().defaultTo('{}'));
      await this.ensureColumn('user_oauth_tokens', 'createdAt', (table) => table.timestamp('createdAt').defaultTo(this.db.fn.now()));
      await this.ensureColumn('user_oauth_tokens', 'updatedAt', (table) => table.timestamp('updatedAt').defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS user_oauth_tokens_user_provider_uidx ON user_oauth_tokens ("userId", "provider")',
      );
    }
  }

  private async createGroupMembersTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('group_members');
    if (!exists) {
      await this.db.schema.createTable('group_members', (table) => {
        table.uuid('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.primary(['groupId', 'userId']);
      });
      console.log('Created "group_members" table.');
    }
  }

  private async createSkillGrantsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('skill_grants');
    if (!exists) {
      await this.db.schema.createTable('skill_grants', (table) => {
        table.bigIncrements('id').primary();
        table.string('principalType').notNullable();
        table.uuid('principalId').notNullable();
        table.string('skillId').notNullable();
        table.string('effect').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['principalType', 'principalId', 'skillId']);
      });
      console.log('Created "skill_grants" table.');
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
        table.boolean('skipPlanApprovals').notNullable().defaultTo(false);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "workspaces" table.');
    } else {
      await this.ensureColumn('workspaces', 'slug', (table) => table.string('slug').notNullable().defaultTo(this.db.raw('md5(random()::text)')));
      await this.ensureColumn('workspaces', 'ownerId', (table) => table.uuid('ownerId'));
      await this.ensureColumn('workspaces', 'lastModifiedBy', (table) => table.uuid('lastModifiedBy'));
      await this.ensureColumn('workspaces', 'skipPlanApprovals', (table) => table.boolean('skipPlanApprovals').notNullable().defaultTo(false));
    }
  }

  private async createMcpServerGroupGrantsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('mcp_server_group_grants');
    if (!exists) {
      await this.db.schema.createTable('mcp_server_group_grants', (table) => {
        table.uuid('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.string('serverId').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.primary(['groupId', 'serverId']);
      });
      console.log('Created "mcp_server_group_grants" table.');
    } else {
      await this.ensureColumn('mcp_server_group_grants', 'serverId', (table) => table.string('serverId').notNullable());
      await this.ensureColumn('mcp_server_group_grants', 'createdAt', (table) => table.timestamp('createdAt').defaultTo(this.db.fn.now()));
      await this.ensureColumn('mcp_server_group_grants', 'updatedAt', (table) => table.timestamp('updatedAt').defaultTo(this.db.fn.now()));
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

  private async createMcpConnectionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('mcp_connections');
    if (!exists) {
      await this.db.schema.createTable('mcp_connections', (table) => {
        table.uuid('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.string('name').notNullable();
        table.string('serverId').notNullable();
        table.string('authType').notNullable();
        table.string('defaultAccess').notNullable().defaultTo('allow');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "mcp_connections" table.');
    }
  }

  private async createMcpConnectionGrantsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('mcp_connection_grants');
    if (!exists) {
      await this.db.schema.createTable('mcp_connection_grants', (table) => {
        table.bigIncrements('id').primary();
        table.string('principalType').notNullable();
        table.uuid('principalId').notNullable();
        table.uuid('connectionId').notNullable().references('id').inTable('mcp_connections').onDelete('CASCADE');
        table.string('effect').notNullable();
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['principalType', 'principalId', 'connectionId']);
      });
      console.log('Created "mcp_connection_grants" table.');
    }
  }

  private async createMcpServerGrantsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('mcp_server_grants');
    if (!exists) {
      await this.db.schema.createTable('mcp_server_grants', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('serverId').notNullable();
        table.string('effect', 16).notNullable(); // 'allow' | 'deny'
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'userId', 'serverId']);
        table.index(['workspaceId', 'userId'], 'mcp_grants_workspace_user_idx');
      });
      console.log('Created "mcp_server_grants" table.');
    } else {
      await this.ensureColumn('mcp_server_grants', 'serverId', (table) => table.string('serverId').notNullable());
      await this.ensureColumn('mcp_server_grants', 'effect', (table) => table.string('effect', 16).notNullable());
      await this.ensureColumn('mcp_server_grants', 'createdAt', (table) => table.timestamp('createdAt').defaultTo(this.db.fn.now()));
      await this.ensureColumn('mcp_server_grants', 'updatedAt', (table) => table.timestamp('updatedAt').defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS mcp_grants_workspace_user_idx ON mcp_server_grants ("workspaceId", "userId")',
      );
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

  private async createCollabDocumentsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('collab_documents');
    if (!exists) {
      await this.db.schema.createTable('collab_documents', (table) => {
        table.string('id').primary();
        table.binary('state');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "collab_documents" table.');
    } else {
      await this.ensureColumn('collab_documents', 'state', (table) => table.binary('state'));
      await this.ensureColumn(
        'collab_documents',
        'updatedAt',
        (table) => table.timestamp('updatedAt').defaultTo(this.db.fn.now()),
      );
    }
  }

  private async createKnowledgeSourcesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('knowledge_sources');
    if (!exists) {
      await this.db.schema.createTable('knowledge_sources', (table) => {
        table.increments('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.string('title').notNullable();
        table.string('type', 32).notNullable();
        table.text('description');
        table.text('content');
        table.integer('fileId').references('id').inTable('files').onDelete('SET NULL');
        table.string('sourceUrl');
        table.jsonb('tags');
        table.jsonb('metadata');
        table.uuid('createdBy').references('id').inTable('users');
        table.uuid('updatedBy').references('id').inTable('users');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['workspaceId', 'type'], 'knowledge_workspace_type_idx');
        table.index(['workspaceId', 'updatedAt'], 'knowledge_workspace_updated_idx');
      });
      console.log('Created \"knowledge_sources\" table.');
    } else {
      await this.ensureColumn('knowledge_sources', 'description', (table) => table.text('description'));
      await this.ensureColumn('knowledge_sources', 'content', (table) => table.text('content'));
      await this.ensureColumn('knowledge_sources', 'fileId', (table) => table.integer('fileId').references('id').inTable('files').onDelete('SET NULL'));
      await this.ensureColumn('knowledge_sources', 'sourceUrl', (table) => table.string('sourceUrl'));
      await this.ensureColumn('knowledge_sources', 'tags', (table) => table.jsonb('tags'));
      await this.ensureColumn('knowledge_sources', 'metadata', (table) => table.jsonb('metadata'));
      await this.ensureColumn('knowledge_sources', 'createdBy', (table) => table.uuid('createdBy'));
      await this.ensureColumn('knowledge_sources', 'updatedBy', (table) => table.uuid('updatedBy'));
      await this.ensureColumn('knowledge_sources', 'createdAt', (table) => table.timestamp('createdAt').defaultTo(this.db.fn.now()));
      await this.ensureColumn('knowledge_sources', 'updatedAt', (table) => table.timestamp('updatedAt').defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS knowledge_workspace_type_idx ON knowledge_sources ("workspaceId", "type")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS knowledge_workspace_updated_idx ON knowledge_sources ("workspaceId", "updatedAt")',
      );
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
        table.jsonb('metadata');
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
    await this.ensureColumn('conversation_messages', 'metadata', (table) => table.jsonb('metadata'));
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS conversation_messages_turn_idx ON conversation_messages ("conversationId", "turnId")'
    );
  }

  private async createAgentRunSummariesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('agent_run_summaries');
    if (!exists) {
      await this.db.schema.createTable('agent_run_summaries', (table) => {
        table.string('runId').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.string('turnId');
        table.string('persona').notNullable();
        table.string('status').notNullable();
        table.string('skillId');
        table.boolean('hadInterrupt').notNullable().defaultTo(false);
        table.integer('approvalInterruptCount').notNullable().defaultTo(0);
        table.integer('clarificationInterruptCount').notNullable().defaultTo(0);
        table.integer('toolCallCount').notNullable().defaultTo(0);
        table.integer('toolErrorCount').notNullable().defaultTo(0);
        table.text('error');
        table.jsonb('metadata');
        table.timestamp('queuedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('startedAt', { useTz: true });
        table.timestamp('completedAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['workspaceId', 'queuedAt'], 'agent_run_summaries_workspace_queued_idx');
        table.index(['userId', 'queuedAt'], 'agent_run_summaries_user_queued_idx');
        table.index(['conversationId', 'queuedAt'], 'agent_run_summaries_conversation_queued_idx');
        table.index(['status', 'completedAt'], 'agent_run_summaries_status_completed_idx');
      });
      console.log('Created "agent_run_summaries" table.');
    } else {
      await this.ensureColumn('agent_run_summaries', 'userId', (table) =>
        table.uuid('userId').references('id').inTable('users').onDelete('SET NULL'));
      await this.ensureColumn('agent_run_summaries', 'conversationId', (table) =>
        table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL'));
      await this.ensureColumn('agent_run_summaries', 'turnId', (table) => table.string('turnId'));
      await this.ensureColumn('agent_run_summaries', 'skillId', (table) => table.string('skillId'));
      await this.ensureColumn('agent_run_summaries', 'hadInterrupt', (table) =>
        table.boolean('hadInterrupt').notNullable().defaultTo(false));
      await this.ensureColumn('agent_run_summaries', 'approvalInterruptCount', (table) =>
        table.integer('approvalInterruptCount').notNullable().defaultTo(0));
      await this.ensureColumn('agent_run_summaries', 'clarificationInterruptCount', (table) =>
        table.integer('clarificationInterruptCount').notNullable().defaultTo(0));
      await this.ensureColumn('agent_run_summaries', 'toolCallCount', (table) =>
        table.integer('toolCallCount').notNullable().defaultTo(0));
      await this.ensureColumn('agent_run_summaries', 'toolErrorCount', (table) =>
        table.integer('toolErrorCount').notNullable().defaultTo(0));
      await this.ensureColumn('agent_run_summaries', 'error', (table) => table.text('error'));
      await this.ensureColumn('agent_run_summaries', 'metadata', (table) => table.jsonb('metadata'));
      await this.ensureColumn('agent_run_summaries', 'queuedAt', (table) =>
        table.timestamp('queuedAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('agent_run_summaries', 'startedAt', (table) =>
        table.timestamp('startedAt', { useTz: true }));
      await this.ensureColumn('agent_run_summaries', 'completedAt', (table) =>
        table.timestamp('completedAt', { useTz: true }));
      await this.ensureColumn('agent_run_summaries', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('agent_run_summaries', 'updatedAt', (table) =>
        table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_summaries_workspace_queued_idx ON agent_run_summaries ("workspaceId", "queuedAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_summaries_user_queued_idx ON agent_run_summaries ("userId", "queuedAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_summaries_conversation_queued_idx ON agent_run_summaries ("conversationId", "queuedAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_summaries_status_completed_idx ON agent_run_summaries ("status", "completedAt")',
      );
    }
  }

  private async createAgentRunToolEventsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('agent_run_tool_events');
    if (!exists) {
      await this.db.schema.createTable('agent_run_tool_events', (table) => {
        table.bigIncrements('id').primary();
        table.string('runId').notNullable().references('runId').inTable('agent_run_summaries').onDelete('CASCADE');
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.string('turnId');
        table.integer('eventIndex').notNullable();
        table.string('toolName').notNullable();
        table.string('eventType').notNullable();
        table.text('summary');
        table.jsonb('outputFiles');
        table.jsonb('payload');
        table.timestamp('eventAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['runId', 'eventIndex']);
        table.index(['workspaceId', 'eventAt'], 'agent_run_tool_events_workspace_event_idx');
        table.index(['toolName', 'eventAt'], 'agent_run_tool_events_tool_event_idx');
      });
      console.log('Created "agent_run_tool_events" table.');
    } else {
      await this.ensureColumn('agent_run_tool_events', 'userId', (table) =>
        table.uuid('userId').references('id').inTable('users').onDelete('SET NULL'));
      await this.ensureColumn('agent_run_tool_events', 'conversationId', (table) =>
        table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL'));
      await this.ensureColumn('agent_run_tool_events', 'turnId', (table) => table.string('turnId'));
      await this.ensureColumn('agent_run_tool_events', 'summary', (table) => table.text('summary'));
      await this.ensureColumn('agent_run_tool_events', 'outputFiles', (table) => table.jsonb('outputFiles'));
      await this.ensureColumn('agent_run_tool_events', 'payload', (table) => table.jsonb('payload'));
      await this.ensureColumn('agent_run_tool_events', 'eventAt', (table) =>
        table.timestamp('eventAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('agent_run_tool_events', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS agent_run_tool_events_run_event_uidx ON agent_run_tool_events ("runId", "eventIndex")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_tool_events_workspace_event_idx ON agent_run_tool_events ("workspaceId", "eventAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_run_tool_events_tool_event_idx ON agent_run_tool_events ("toolName", "eventAt")',
      );
    }
  }

  private async createAgentDailyReflectionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('agent_daily_reflections');
    if (!exists) {
      await this.db.schema.createTable('agent_daily_reflections', (table) => {
        table.bigIncrements('id').primary();
        table.date('reflectionDate').notNullable();
        table.string('timezone').notNullable();
        table.string('status').notNullable().defaultTo('ready');
        table.integer('outcomeScore').notNullable().defaultTo(0);
        table.integer('reliabilityScore').notNullable().defaultTo(0);
        table.integer('frictionScore').notNullable().defaultTo(0);
        table.text('summaryMarkdown').notNullable().defaultTo('');
        table.jsonb('metrics').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.jsonb('recommendations').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.jsonb('sampledConversations').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['reflectionDate', 'timezone']);
        table.index(['reflectionDate', 'timezone'], 'agent_daily_reflections_date_timezone_idx');
      });
      console.log('Created "agent_daily_reflections" table.');
    } else {
      await this.ensureColumn('agent_daily_reflections', 'status', (table) =>
        table.string('status').notNullable().defaultTo('ready'));
      await this.ensureColumn('agent_daily_reflections', 'outcomeScore', (table) =>
        table.integer('outcomeScore').notNullable().defaultTo(0));
      await this.ensureColumn('agent_daily_reflections', 'reliabilityScore', (table) =>
        table.integer('reliabilityScore').notNullable().defaultTo(0));
      await this.ensureColumn('agent_daily_reflections', 'frictionScore', (table) =>
        table.integer('frictionScore').notNullable().defaultTo(0));
      await this.ensureColumn('agent_daily_reflections', 'summaryMarkdown', (table) =>
        table.text('summaryMarkdown').notNullable().defaultTo(''));
      await this.ensureColumn('agent_daily_reflections', 'metrics', (table) =>
        table.jsonb('metrics').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`)));
      await this.ensureColumn('agent_daily_reflections', 'recommendations', (table) =>
        table.jsonb('recommendations').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`)));
      await this.ensureColumn('agent_daily_reflections', 'sampledConversations', (table) =>
        table.jsonb('sampledConversations').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`)));
      await this.ensureColumn('agent_daily_reflections', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('agent_daily_reflections', 'updatedAt', (table) =>
        table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS agent_daily_reflections_date_timezone_uidx ON agent_daily_reflections ("reflectionDate", "timezone")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_daily_reflections_date_timezone_idx ON agent_daily_reflections ("reflectionDate", "timezone")',
      );
    }
  }

  private async createAgentDailyReflectionBreakdownsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('agent_daily_reflection_breakdowns');
    if (!exists) {
      await this.db.schema.createTable('agent_daily_reflection_breakdowns', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('reflectionId').notNullable().references('id').inTable('agent_daily_reflections').onDelete('CASCADE');
        table.string('dimension').notNullable();
        table.string('entityKey').notNullable();
        table.string('label').notNullable();
        table.integer('rank').notNullable().defaultTo(0);
        table.jsonb('metrics').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.text('summary');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['reflectionId', 'dimension', 'entityKey']);
        table.index(['reflectionId', 'dimension', 'rank'], 'agent_daily_reflection_breakdowns_reflection_dimension_rank_idx');
      });
      console.log('Created "agent_daily_reflection_breakdowns" table.');
    } else {
      await this.ensureColumn('agent_daily_reflection_breakdowns', 'rank', (table) =>
        table.integer('rank').notNullable().defaultTo(0));
      await this.ensureColumn('agent_daily_reflection_breakdowns', 'metrics', (table) =>
        table.jsonb('metrics').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`)));
      await this.ensureColumn('agent_daily_reflection_breakdowns', 'summary', (table) => table.text('summary'));
      await this.ensureColumn('agent_daily_reflection_breakdowns', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS agent_daily_reflection_breakdowns_reflection_dimension_entity_uidx ON agent_daily_reflection_breakdowns ("reflectionId", "dimension", "entityKey")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS agent_daily_reflection_breakdowns_reflection_dimension_rank_idx ON agent_daily_reflection_breakdowns ("reflectionId", "dimension", "rank")',
      );
    }
  }

  private async createUserMemorySuggestionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('user_memory_suggestions');
    if (!exists) {
      await this.db.schema.createTable('user_memory_suggestions', (table) => {
        table.uuid('id').primary();
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('workspaceId').references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('sourceConversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.string('sourceRunId').references('runId').inTable('agent_run_summaries').onDelete('SET NULL');
        table.string('targetPath').notNullable();
        table.string('targetScope').notNullable();
        table.string('targetSection').notNullable();
        table.string('baseContentHash').notNullable();
        table.text('proposedContent').notNullable();
        table.text('rationale').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.text('reviewedContent');
        table.timestamp('reviewedAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['userId', 'status', 'createdAt'], 'user_memory_suggestions_user_status_created_idx');
        table.index(['workspaceId', 'status', 'createdAt'], 'user_memory_suggestions_workspace_status_created_idx');
      });
      console.log('Created "user_memory_suggestions" table.');
    } else {
      await this.ensureColumn('user_memory_suggestions', 'sourceRunId', (table) =>
        table.string('sourceRunId').references('runId').inTable('agent_run_summaries').onDelete('SET NULL'));
      await this.ensureColumn('user_memory_suggestions', 'targetPath', (table) => table.string('targetPath').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'targetScope', (table) => table.string('targetScope').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'targetSection', (table) => table.string('targetSection').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'baseContentHash', (table) => table.string('baseContentHash').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'proposedContent', (table) => table.text('proposedContent').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'rationale', (table) => table.text('rationale').notNullable());
      await this.ensureColumn('user_memory_suggestions', 'status', (table) =>
        table.string('status').notNullable().defaultTo('pending'));
      await this.ensureColumn('user_memory_suggestions', 'reviewedContent', (table) => table.text('reviewedContent'));
      await this.ensureColumn('user_memory_suggestions', 'reviewedAt', (table) =>
        table.timestamp('reviewedAt', { useTz: true }));
      await this.ensureColumn('user_memory_suggestions', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('user_memory_suggestions', 'updatedAt', (table) =>
        table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS user_memory_suggestions_user_status_created_idx ON user_memory_suggestions ("userId", "status", "createdAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS user_memory_suggestions_workspace_status_created_idx ON user_memory_suggestions ("workspaceId", "status", "createdAt")',
      );
    }
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
