import knex, { Knex } from 'knex';
import { getBackendEnv } from '../config/env';

type PgConnection = Knex.PgConnectionConfig | string | Knex.StaticConnectionConfig;

export class DatabaseService {
  private db: Knex;

  constructor() {
    const env = getBackendEnv();
    this.db = knex({
      client: 'pg',
      connection: this.buildConnectionConfig(env),
      pool: {
        min: env.database.poolMin,
        max: env.database.poolMax,
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
    await this.migrateWorkspaceVisibility();
    await this.createMcpServerGrantsTable();
    await this.createMcpConnectionsTable();
    await this.createMcpConnectionGrantsTable();
    await this.createFilesTable();
    await this.createWorkspacePublishedVersionsTable();
    await this.createWorkspacePublicationLinksTable();
    await this.createWorkspaceTeamMessagesTable();
    await this.createWorkspaceTeamMessageMentionsTable();
    await this.createWorkspaceCollaborationObjectsTable();
    await this.createWorkspaceCollaborationMessagesTable();
    await this.createWorkspaceCollaborationMentionsTable();
    await this.createCollabDocumentsTable();
    await this.createKnowledgeSourcesTable();
    await this.createKnowledgeSourceGroupGrantsTable();
    await this.createKnowledgeIngestionTables();
    await this.createConversationsTable();
    await this.createConversationMessagesTable();
    await this.createWorkspaceSchedulesTable();
    await this.createWorkspaceScheduleRunsTable();
    await this.createAgentRunSummariesTable();
    await this.createAgentRunToolEventsTable();
    await this.createAgentDailyReflectionsTable();
    await this.createAgentDailyReflectionBreakdownsTable();
    await this.createUserMemorySuggestionsTable();
    await this.createSkillEvolutionSuggestionsTable();
    await this.createUnifiedGovernanceTables();
  }

  private buildConnectionConfig(env: ReturnType<typeof getBackendEnv>): PgConnection {
    const ssl = this.buildSSLConfig(env.database.sslRaw);
    const connectionString = env.database.connectionString;
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
      host: env.database.host,
      port: env.database.port,
      database: env.database.database,
      user: env.database.user,
      password: env.database.password,
    };

    if (ssl) {
      config.ssl = ssl;
    }

    return config;
  }

  private buildSSLConfig(rawOverride: string | undefined): false | { rejectUnauthorized: boolean } {
    const raw = (rawOverride || '').toLowerCase();
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
        table.string('visibility', 16).notNullable().defaultTo('private');
        table.uuid('teamId').references('id').inTable('groups').onDelete('SET NULL');
        table.uuid('currentPublishedVersionId');
        table.integer('contentRevision').notNullable().defaultTo(0);
        table.boolean('skipPlanApprovals').notNullable().defaultTo(false);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
      });
      console.log('Created "workspaces" table.');
    } else {
      await this.ensureColumn('workspaces', 'slug', (table) => table.string('slug').notNullable().defaultTo(this.db.raw('md5(random()::text)')));
      await this.ensureColumn('workspaces', 'ownerId', (table) => table.uuid('ownerId'));
      await this.ensureColumn('workspaces', 'lastModifiedBy', (table) => table.uuid('lastModifiedBy'));
      await this.ensureColumn('workspaces', 'visibility', (table) => table.string('visibility', 16).notNullable().defaultTo('private'));
      await this.ensureColumn('workspaces', 'teamId', (table) => table.uuid('teamId').references('id').inTable('groups').onDelete('SET NULL'));
      await this.ensureColumn('workspaces', 'currentPublishedVersionId', (table) => table.uuid('currentPublishedVersionId'));
      await this.ensureColumn('workspaces', 'contentRevision', (table) => table.integer('contentRevision').notNullable().defaultTo(0));
      await this.ensureColumn('workspaces', 'skipPlanApprovals', (table) => table.boolean('skipPlanApprovals').notNullable().defaultTo(false));
    }
  }

  private async migrateWorkspaceVisibility(): Promise<void> {
    await this.db.raw(`
      UPDATE workspaces
      SET visibility = 'team'
      WHERE visibility = 'private'
        AND (
          SELECT COUNT(*)
          FROM workspace_members
          WHERE workspace_members."workspaceId" = workspaces.id
        ) > 1
    `);
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
        table.string('sourceProvider', 64);
        table.string('sourceExternalId');
        table.string('sourceVersionFingerprint');
        table.string('sourceUrl');
        table.uuid('createdBy').references('id').inTable('users');
        table.uuid('updatedBy').references('id').inTable('users');
        table.integer('version').notNullable().defaultTo(1);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['workspaceId', 'name']);
        table.index(['workspaceId', 'updatedAt'], 'files_workspace_updated_idx');
        table.index(
          ['workspaceId', 'sourceProvider', 'sourceExternalId', 'sourceVersionFingerprint'],
          'files_workspace_source_version_idx',
        );
      });
      console.log('Created "files" table.');
    } else {
      await this.ensureFilesTableColumns();
    }
  }

  private async createWorkspacePublishedVersionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_published_versions');
    if (!exists) {
      await this.db.schema.createTable('workspace_published_versions', (table) => {
        table.uuid('id').primary();
        table.uuid('teamWorkspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.integer('versionNumber').notNullable();
        table.uuid('sourcePrivateWorkspaceId').references('id').inTable('workspaces').onDelete('SET NULL');
        table.uuid('publisherUserId').references('id').inTable('users').onDelete('SET NULL');
        table.text('note');
        table.jsonb('manifest').notNullable().defaultTo('[]');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['teamWorkspaceId', 'versionNumber']);
        table.index(['teamWorkspaceId', 'createdAt'], 'workspace_published_versions_team_created_idx');
      });
      console.log('Created "workspace_published_versions" table.');
    } else {
      const foreignKeys = await this.db.raw<{
        rows: Array<{ constraint_name: string; delete_rule: string }>;
      }>(`
        SELECT tc.constraint_name, rc.delete_rule
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
        JOIN information_schema.referential_constraints AS rc
          ON tc.constraint_name = rc.constraint_name
          AND tc.constraint_schema = rc.constraint_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'workspace_published_versions'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'publisherUserId'
      `);
      const publisherForeignKey = foreignKeys.rows[0];
      if (publisherForeignKey?.delete_rule !== 'SET NULL') {
        if (publisherForeignKey) {
          await this.db.raw(
            'ALTER TABLE ?? DROP CONSTRAINT ??',
            ['workspace_published_versions', publisherForeignKey.constraint_name],
          );
        }
        await this.db.schema.alterTable('workspace_published_versions', (table) => {
          table.uuid('publisherUserId').nullable().alter();
          table.foreign('publisherUserId').references('id').inTable('users').onDelete('SET NULL');
        });
      }
    }
  }

  private async createWorkspacePublicationLinksTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_publication_links');
    if (!exists) {
      await this.db.schema.createTable('workspace_publication_links', (table) => {
        table.uuid('privateWorkspaceId').primary().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('teamWorkspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('basePublishedVersionId').references('id').inTable('workspace_published_versions').onDelete('SET NULL');
        table.integer('basePrivateContentRevision').notNullable().defaultTo(0);
        table.boolean('hasUnpublishedChanges').notNullable().defaultTo(false);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['teamWorkspaceId', 'userId']);
        table.index(['userId', 'teamWorkspaceId'], 'workspace_publication_links_user_team_idx');
      });
      console.log('Created "workspace_publication_links" table.');
    } else {
      await this.ensureColumn(
        'workspace_publication_links',
        'hasUnpublishedChanges',
        (table) => table.boolean('hasUnpublishedChanges').notNullable().defaultTo(false),
      );
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
        table.boolean('isGlobal').notNullable().defaultTo(false);
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
      await this.ensureColumn('knowledge_sources', 'isGlobal', (table) => table.boolean('isGlobal').notNullable().defaultTo(false));
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

  private async createKnowledgeSourceGroupGrantsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('knowledge_source_group_grants');
    if (!exists) {
      await this.db.schema.createTable('knowledge_source_group_grants', (table) => {
        table.uuid('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.integer('knowledgeSourceId').notNullable().references('id').inTable('knowledge_sources').onDelete('CASCADE');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.primary(['groupId', 'knowledgeSourceId']);
        table.index(['knowledgeSourceId', 'groupId'], 'knowledge_source_group_grants_source_group_idx');
      });
      console.log('Created "knowledge_source_group_grants" table.');
    }
  }

  private async createKnowledgeIngestionTables(): Promise<void> {
    if (!await this.db.schema.hasTable('knowledge_ingestion_jobs')) {
      await this.db.schema.createTable('knowledge_ingestion_jobs', (table) => {
        table.uuid('id').primary();
        table.integer('knowledgeId').notNullable().references('id').inTable('knowledge_sources').onDelete('CASCADE');
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.integer('sourceFileId').references('id').inTable('files').onDelete('SET NULL');
        table.string('status', 32).notNullable().defaultTo('queued');
        table.string('stage', 32).notNullable().defaultTo('queued');
        table.string('sourceFingerprint');
        table.string('snapshotHash');
        table.string('bundlePath');
        table.string('extractorVersion');
        table.string('enrichmentVersion');
        table.string('okfGeneratorVersion');
        table.string('modelProfile');
        table.jsonb('configuration').notNullable().defaultTo('{}');
        table.integer('discoveredSourceUnits').notNullable().defaultTo(0);
        table.integer('processedSourceUnits').notNullable().defaultTo(0);
        table.integer('failedSourceUnits').notNullable().defaultTo(0);
        table.jsonb('warnings').notNullable().defaultTo('[]');
        table.text('error');
        table.timestamp('startedAt');
        table.timestamp('finishedAt');
        table.timestamp('cancelledAt');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['knowledgeId', 'createdAt'], 'knowledge_ingestion_jobs_source_created_idx');
        table.index(['status', 'updatedAt'], 'knowledge_ingestion_jobs_status_updated_idx');
      });
    }
    await this.ensureColumn('knowledge_ingestion_jobs', 'snapshotHash', (table) => table.string('snapshotHash'));
    await this.ensureColumn('knowledge_ingestion_jobs', 'bundlePath', (table) => table.string('bundlePath'));

    if (!await this.db.schema.hasTable('knowledge_ingestion_tasks')) {
      await this.db.schema.createTable('knowledge_ingestion_tasks', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.string('taskType', 48).notNullable();
        table.string('contentHash');
        table.string('status', 24).notNullable().defaultTo('queued');
        table.integer('attempts').notNullable().defaultTo(0);
        table.integer('maxAttempts').notNullable().defaultTo(3);
        table.string('leaseOwner');
        table.timestamp('leaseExpiresAt');
        table.timestamp('retryAt');
        table.jsonb('input').notNullable().defaultTo('{}');
        table.jsonb('result');
        table.text('error');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['status', 'retryAt', 'leaseExpiresAt'], 'knowledge_tasks_claim_idx');
        table.index(['runId', 'taskType'], 'knowledge_tasks_run_type_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_source_blocks')) {
      await this.db.schema.createTable('knowledge_source_blocks', (table) => {
        table.bigIncrements('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.string('blockId').notNullable();
        table.integer('ordinal').notNullable();
        table.string('blockType', 24).notNullable();
        table.text('text');
        table.jsonb('locator').notNullable().defaultTo('{}');
        table.string('extractionMethod', 24).notNullable().defaultTo('native');
        table.decimal('extractionConfidence', 6, 5).notNullable().defaultTo(1);
        table.string('contentHash').notNullable();
        table.unique(['runId', 'blockId']);
        table.index(['runId', 'ordinal'], 'knowledge_blocks_run_ordinal_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_structure_nodes')) {
      await this.db.schema.createTable('knowledge_structure_nodes', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.uuid('parentId');
        table.string('externalId').notNullable();
        table.string('title').notNullable();
        table.integer('level').notNullable();
        table.jsonb('blockIds').notNullable().defaultTo('[]');
        table.jsonb('signals').notNullable().defaultTo('[]');
        table.decimal('confidence', 6, 5).notNullable();
        table.jsonb('sourceRange').notNullable().defaultTo('{}');
        table.unique(['runId', 'externalId']);
      });
    }

    if (!await this.db.schema.hasTable('knowledge_processing_windows')) {
      await this.db.schema.createTable('knowledge_processing_windows', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.string('externalId').notNullable();
        table.string('structureNodeId').notNullable();
        table.jsonb('coreBlockIds').notNullable().defaultTo('[]');
        table.jsonb('contextBeforeBlockIds').notNullable().defaultTo('[]');
        table.jsonb('contextAfterBlockIds').notNullable().defaultTo('[]');
        table.integer('tokenCount').notNullable();
        table.string('contentHash').notNullable();
        table.string('strategy', 24).notNullable();
        table.string('status', 24).notNullable().defaultTo('queued');
        table.unique(['runId', 'externalId']);
        table.index(['runId', 'status'], 'knowledge_windows_run_status_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_candidate_concepts')) {
      await this.db.schema.createTable('knowledge_candidate_concepts', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.uuid('windowId').references('id').inTable('knowledge_processing_windows').onDelete('CASCADE');
        table.string('candidateId').notNullable();
        table.string('kind', 64).notNullable();
        table.string('name').notNullable();
        table.jsonb('payload').notNullable();
        table.decimal('confidence', 6, 5);
        table.string('contentHash').notNullable();
        table.unique(['runId', 'candidateId']);
      });
    }

    if (!await this.db.schema.hasTable('knowledge_snapshots')) {
      await this.db.schema.createTable('knowledge_snapshots', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.integer('knowledgeId').notNullable().references('id').inTable('knowledge_sources').onDelete('CASCADE');
        table.string('contentHash').notNullable();
        table.string('artifactPath').notNullable();
        table.string('generatorVersion').notNullable();
        table.boolean('isPublished').notNullable().defaultTo(false);
        table.timestamp('publishedAt');
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.unique(['knowledgeId', 'contentHash']);
        table.unique(['runId']);
      });
    }

    if (!await this.db.schema.hasTable('knowledge_concepts')) {
      await this.db.schema.createTable('knowledge_concepts', (table) => {
        table.bigIncrements('pk').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.string('id').notNullable();
        table.string('kind', 64).notNullable();
        table.string('name').notNullable();
        table.text('description');
        table.jsonb('aliases').notNullable().defaultTo('[]');
        table.jsonb('tags').notNullable().defaultTo('[]');
        table.string('path').notNullable();
        table.decimal('confidence', 6, 5).notNullable().defaultTo(1);
        table.unique(['snapshotId', 'id']);
        table.index(['snapshotId', 'kind'], 'knowledge_concepts_snapshot_kind_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_evidence_spans')) {
      await this.db.schema.createTable('knowledge_evidence_spans', (table) => {
        table.uuid('id').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.integer('sourceFileId').references('id').inTable('files').onDelete('SET NULL');
        table.jsonb('blockIds').notNullable().defaultTo('[]');
        table.jsonb('locator').notNullable();
        table.string('contentHash');
        table.index(['snapshotId'], 'knowledge_evidence_snapshot_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_assertions')) {
      await this.db.schema.createTable('knowledge_assertions', (table) => {
        table.uuid('id').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.string('conceptId').notNullable();
        table.text('text').notNullable();
        table.decimal('confidence', 6, 5).notNullable();
        table.jsonb('evidenceSpanIds').notNullable().defaultTo('[]');
        table.string('contentHash').notNullable();
        table.index(['snapshotId', 'conceptId'], 'knowledge_assertions_snapshot_concept_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_relationships')) {
      await this.db.schema.createTable('knowledge_relationships', (table) => {
        table.uuid('id').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.string('sourceConceptId').notNullable();
        table.string('targetConceptId').notNullable();
        table.string('type', 96).notNullable();
        table.string('confidenceClass', 16).notNullable();
        table.decimal('confidence', 6, 5).notNullable();
        table.jsonb('evidenceSpanIds').notNullable().defaultTo('[]');
        table.index(['snapshotId', 'sourceConceptId'], 'knowledge_relationships_source_idx');
        table.index(['snapshotId', 'targetConceptId'], 'knowledge_relationships_target_idx');
      });
    }

    let vectorAvailable = false;
    if (process.env.KNOWLEDGE_VECTOR_ENABLED === 'true') {
      try {
        await this.db.raw('CREATE EXTENSION IF NOT EXISTS vector');
        vectorAvailable = true;
      } catch (error) {
        console.warn('pgvector is unavailable; Knowledge embeddings will use JSON storage.', error);
      }
    }
    try {
      await this.db.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    } catch (error) {
      console.warn('pg_trgm is unavailable; fuzzy Knowledge retrieval will be disabled.', error);
    }
    if (!await this.db.schema.hasTable('knowledge_embeddings')) {
      await this.db.schema.createTable('knowledge_embeddings', (table) => {
        table.uuid('id').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.string('ownerType', 24).notNullable();
        table.string('ownerId').notNullable();
        table.string('model').notNullable();
        table.integer('dimensions').notNullable().defaultTo(768);
        table.string('modality', 24).notNullable().defaultTo('text');
        table.string('indexVersion').notNullable().defaultTo('knowledge-vector/1');
        table.string('contentHash').notNullable();
        if (vectorAvailable) table.specificType('embedding', 'vector');
        else table.jsonb('embedding');
        table.unique(['snapshotId', 'ownerType', 'ownerId', 'model']);
      });
    }
    await this.ensureColumn('knowledge_embeddings', 'dimensions', (table) => table.integer('dimensions').notNullable().defaultTo(768));
    await this.ensureColumn('knowledge_embeddings', 'modality', (table) => table.string('modality', 24).notNullable().defaultTo('text'));
    await this.ensureColumn('knowledge_embeddings', 'indexVersion', (table) => table.string('indexVersion').notNullable().defaultTo('knowledge-vector/1'));

    if (!await this.db.schema.hasTable('knowledge_communities')) {
      await this.db.schema.createTable('knowledge_communities', (table) => {
        table.uuid('id').primary();
        table.uuid('snapshotId').notNullable().references('id').inTable('knowledge_snapshots').onDelete('CASCADE');
        table.string('algorithm').notNullable();
        table.string('algorithmVersion').notNullable();
        table.string('label');
        table.jsonb('conceptIds').notNullable().defaultTo('[]');
        table.jsonb('metadata').notNullable().defaultTo('{}');
        table.index(['snapshotId'], 'knowledge_communities_snapshot_idx');
      });
    }

    if (!await this.db.schema.hasTable('knowledge_usage_events')) {
      await this.db.schema.createTable('knowledge_usage_events', (table) => {
        table.uuid('id').primary();
        table.uuid('runId').notNullable().references('id').inTable('knowledge_ingestion_jobs').onDelete('CASCADE');
        table.string('stage', 32).notNullable();
        table.string('provider');
        table.string('model');
        table.string('promptVersion');
        table.string('schemaVersion');
        table.integer('inputTokens').notNullable().defaultTo(0);
        table.integer('cachedInputTokens').notNullable().defaultTo(0);
        table.integer('outputTokens').notNullable().defaultTo(0);
        table.integer('retries').notNullable().defaultTo(0);
        table.integer('latencyMs').notNullable().defaultTo(0);
        table.string('rateCardVersion');
        table.decimal('estimatedCost', 18, 8).notNullable().defaultTo(0);
        table.timestamp('createdAt').notNullable().defaultTo(this.db.fn.now());
        table.index(['runId', 'stage'], 'knowledge_usage_run_stage_idx');
      });
    }
    try {
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS knowledge_concepts_name_trgm_idx ON knowledge_concepts USING gin (name gin_trgm_ops)',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS knowledge_assertions_text_trgm_idx ON knowledge_assertions USING gin (text gin_trgm_ops)',
      );
    } catch (error) {
      console.warn('Knowledge trigram indexes could not be created.', error);
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

  private async createWorkspaceCollaborationObjectsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_collaboration_objects');
    if (!exists) {
      await this.db.schema.createTable('workspace_collaboration_objects', (table) => {
        table.uuid('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('originVersionId').references('id').inTable('workspace_published_versions').onDelete('SET NULL');
        table.string('type', 32).notNullable();
        table.string('visibility', 32).notNullable().defaultTo('workspace_audience');
        table.string('status', 32).notNullable().defaultTo('open');
        table.integer('fileId').references('id').inTable('files').onDelete('SET NULL');
        table.string('filePath');
        table.string('blockId');
        table.text('anchorText');
        table.integer('anchorStart');
        table.integer('anchorEnd');
        table.string('anchorFingerprint');
        table.string('title');
        table.text('body').notNullable();
        table.uuid('authorId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('assigneeId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('linkedPrivateWorkspaceId').references('id').inTable('workspaces').onDelete('SET NULL');
        table.uuid('resolvedByVersionId').references('id').inTable('workspace_published_versions').onDelete('SET NULL');
        table.uuid('sourceTeamMessageId')
          .references('id')
          .inTable('workspace_team_messages')
          .onDelete('SET NULL');
        table.timestamp('dueAt', { useTz: true });
        table.timestamp('resolvedAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(
          ['workspaceId', 'status', 'updatedAt'],
          'workspace_collaboration_objects_workspace_status_idx',
        );
        table.index(
          ['workspaceId', 'filePath', 'updatedAt'],
          'workspace_collaboration_objects_anchor_idx',
        );
        table.index(
          ['sourceTeamMessageId'],
          'workspace_collaboration_objects_source_team_message_idx',
        );
      });
      console.log('Created "workspace_collaboration_objects" table.');
    } else {
      await this.ensureColumn('workspace_collaboration_objects', 'sourceTeamMessageId', (table) =>
        table.uuid('sourceTeamMessageId')
          .references('id')
          .inTable('workspace_team_messages')
          .onDelete('SET NULL'));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS workspace_collaboration_objects_source_team_message_idx ON workspace_collaboration_objects ("sourceTeamMessageId")',
      );
    }
  }

  private async createWorkspaceTeamMessagesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_team_messages');
    if (!exists) {
      await this.db.schema.createTable('workspace_team_messages', (table) => {
        table.uuid('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('originVersionId').references('id').inTable('workspace_published_versions').onDelete('SET NULL');
        table.uuid('authorId').references('id').inTable('users').onDelete('SET NULL');
        table.string('authorType', 16).notNullable().defaultTo('user');
        table.text('body').notNullable();
        table.uuid('replyToMessageId')
          .references('id')
          .inTable('workspace_team_messages')
          .onDelete('SET NULL');
        table.uuid('threadRootId')
          .references('id')
          .inTable('workspace_team_messages')
          .onDelete('CASCADE');
        table.boolean('mentionsLumo').notNullable().defaultTo(false);
        table.jsonb('metadata');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(
          ['workspaceId', 'createdAt'],
          'workspace_team_messages_workspace_created_idx',
        );
        table.index(
          ['threadRootId', 'createdAt'],
          'workspace_team_messages_thread_created_idx',
        );
      });
      await this.db.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_team_messages_lumo_reply_uidx
         ON workspace_team_messages ("replyToMessageId")
         WHERE "authorType" = 'lumo'`,
      );
      console.log('Created "workspace_team_messages" table.');
    }
  }

  private async createWorkspaceTeamMessageMentionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_team_message_mentions');
    if (!exists) {
      await this.db.schema.createTable('workspace_team_message_mentions', (table) => {
        table.uuid('messageId')
          .notNullable()
          .references('id')
          .inTable('workspace_team_messages')
          .onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['messageId', 'userId']);
        table.index(
          ['userId', 'createdAt'],
          'workspace_team_message_mentions_user_created_idx',
        );
      });
      console.log('Created "workspace_team_message_mentions" table.');
    }
  }

  private async createWorkspaceCollaborationMessagesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_collaboration_messages');
    if (!exists) {
      await this.db.schema.createTable('workspace_collaboration_messages', (table) => {
        table.uuid('id').primary();
        table.uuid('objectId')
          .notNullable()
          .references('id')
          .inTable('workspace_collaboration_objects')
          .onDelete('CASCADE');
        table.uuid('authorId').references('id').inTable('users').onDelete('SET NULL');
        table.text('body').notNullable();
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(
          ['objectId', 'createdAt'],
          'workspace_collaboration_messages_object_created_idx',
        );
      });
      console.log('Created "workspace_collaboration_messages" table.');
    }
  }

  private async createWorkspaceCollaborationMentionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_collaboration_mentions');
    if (!exists) {
      await this.db.schema.createTable('workspace_collaboration_mentions', (table) => {
        table.uuid('objectId')
          .notNullable()
          .references('id')
          .inTable('workspace_collaboration_objects')
          .onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['objectId', 'userId']);
        table.index(['userId', 'createdAt'], 'workspace_collaboration_mentions_user_created_idx');
      });
      console.log('Created "workspace_collaboration_mentions" table.');
    }
  }

  private async ensureFilesTableColumns(): Promise<void> {
    await this.ensureColumn('files', 'mimeType', (table) => table.string('mimeType'));
    await this.ensureColumn('files', 'publicUrl', (table) => table.string('publicUrl'));
    await this.ensureColumn('files', 'sourceProvider', (table) => table.string('sourceProvider', 64));
    await this.ensureColumn('files', 'sourceExternalId', (table) => table.string('sourceExternalId'));
    await this.ensureColumn('files', 'sourceVersionFingerprint', (table) => table.string('sourceVersionFingerprint'));
    await this.ensureColumn('files', 'sourceUrl', (table) => table.string('sourceUrl'));
    await this.ensureColumn('files', 'createdBy', (table) => table.uuid('createdBy'));
    await this.ensureColumn('files', 'updatedBy', (table) => table.uuid('updatedBy'));
    await this.ensureColumn('files', 'version', (table) => table.integer('version').notNullable().defaultTo(1));
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS files_workspace_source_version_idx ON files ("workspaceId", "sourceProvider", "sourceExternalId", "sourceVersionFingerprint")',
    );
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

  private async createWorkspaceSchedulesTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_schedules');
    if (!exists) {
      await this.db.schema.createTable('workspace_schedules', (table) => {
        table.uuid('id').primary();
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('createdBy').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('runAsUserId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('sourceConversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.integer('sourceMessageId').references('id').inTable('conversation_messages').onDelete('SET NULL');
        table.uuid('targetConversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.string('name').notNullable();
        table.string('status', 32).notNullable().defaultTo('active');
        table.string('cadence', 32).notNullable().defaultTo('daily');
        table.string('cronExpression').notNullable();
        table.string('timezone').notNullable().defaultTo('UTC');
        table.text('prompt').notNullable();
        table.string('persona').notNullable().defaultTo('fast');
        table.jsonb('selectedSkills').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.jsonb('contextRefs').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.jsonb('taggedFiles').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.string('outputMode', 64).notNullable().defaultTo('append_to_conversation');
        table.string('notificationMode', 32).notNullable().defaultTo('none');
        table.timestamp('nextRunAt', { useTz: true });
        table.timestamp('lastRunAt', { useTz: true });
        table.string('lastRunStatus', 32);
        table.text('lastError');
        table.timestamp('lockedAt', { useTz: true });
        table.string('lockedBy');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['workspaceId', 'status'], 'workspace_schedules_workspace_status_idx');
        table.index(['status', 'nextRunAt'], 'workspace_schedules_status_next_run_idx');
      });
      console.log('Created "workspace_schedules" table.');
    } else {
      await this.ensureWorkspaceScheduleColumns();
    }
  }

  private async ensureWorkspaceScheduleColumns(): Promise<void> {
    await this.ensureColumn('workspace_schedules', 'createdBy', (table) =>
      table.uuid('createdBy').references('id').inTable('users').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedules', 'runAsUserId', (table) =>
      table.uuid('runAsUserId').references('id').inTable('users').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedules', 'sourceConversationId', (table) =>
      table.uuid('sourceConversationId').references('id').inTable('conversations').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedules', 'sourceMessageId', (table) =>
      table.integer('sourceMessageId').references('id').inTable('conversation_messages').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedules', 'targetConversationId', (table) =>
      table.uuid('targetConversationId').references('id').inTable('conversations').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedules', 'status', (table) =>
      table.string('status', 32).notNullable().defaultTo('active'));
    await this.ensureColumn('workspace_schedules', 'cadence', (table) =>
      table.string('cadence', 32).notNullable().defaultTo('daily'));
    await this.ensureColumn('workspace_schedules', 'cronExpression', (table) =>
      table.string('cronExpression').notNullable().defaultTo('0 9 * * *'));
    await this.ensureColumn('workspace_schedules', 'timezone', (table) =>
      table.string('timezone').notNullable().defaultTo('UTC'));
    await this.ensureColumn('workspace_schedules', 'prompt', (table) =>
      table.text('prompt').notNullable().defaultTo(''));
    await this.ensureColumn('workspace_schedules', 'persona', (table) =>
      table.string('persona').notNullable().defaultTo('fast'));
    await this.ensureColumn('workspace_schedules', 'selectedSkills', (table) =>
      table.jsonb('selectedSkills').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`)));
    await this.ensureColumn('workspace_schedules', 'contextRefs', (table) =>
      table.jsonb('contextRefs').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`)));
    await this.ensureColumn('workspace_schedules', 'taggedFiles', (table) =>
      table.jsonb('taggedFiles').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`)));
    await this.ensureColumn('workspace_schedules', 'outputMode', (table) =>
      table.string('outputMode', 64).notNullable().defaultTo('append_to_conversation'));
    await this.ensureColumn('workspace_schedules', 'notificationMode', (table) =>
      table.string('notificationMode', 32).notNullable().defaultTo('none'));
    await this.ensureColumn('workspace_schedules', 'nextRunAt', (table) =>
      table.timestamp('nextRunAt', { useTz: true }));
    await this.ensureColumn('workspace_schedules', 'lastRunAt', (table) =>
      table.timestamp('lastRunAt', { useTz: true }));
    await this.ensureColumn('workspace_schedules', 'lastRunStatus', (table) => table.string('lastRunStatus', 32));
    await this.ensureColumn('workspace_schedules', 'lastError', (table) => table.text('lastError'));
    await this.ensureColumn('workspace_schedules', 'lockedAt', (table) =>
      table.timestamp('lockedAt', { useTz: true }));
    await this.ensureColumn('workspace_schedules', 'lockedBy', (table) => table.string('lockedBy'));
    await this.ensureColumn('workspace_schedules', 'createdAt', (table) =>
      table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
    await this.ensureColumn('workspace_schedules', 'updatedAt', (table) =>
      table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS workspace_schedules_workspace_status_idx ON workspace_schedules ("workspaceId", "status")',
    );
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS workspace_schedules_status_next_run_idx ON workspace_schedules ("status", "nextRunAt")',
    );
  }

  private async createWorkspaceScheduleRunsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('workspace_schedule_runs');
    if (!exists) {
      await this.db.schema.createTable('workspace_schedule_runs', (table) => {
        table.uuid('id').primary();
        table.uuid('scheduleId').notNullable().references('id').inTable('workspace_schedules').onDelete('CASCADE');
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL');
        table.string('agentRunId');
        table.string('status', 32).notNullable().defaultTo('queued');
        table.string('triggeredBy', 32).notNullable().defaultTo('scheduler');
        table.text('error');
        table.timestamp('startedAt', { useTz: true });
        table.timestamp('completedAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['scheduleId', 'createdAt'], 'workspace_schedule_runs_schedule_created_idx');
        table.index(['agentRunId'], 'workspace_schedule_runs_agent_run_idx');
        table.index(['status', 'updatedAt'], 'workspace_schedule_runs_status_updated_idx');
      });
      console.log('Created "workspace_schedule_runs" table.');
    } else {
      await this.ensureWorkspaceScheduleRunColumns();
    }
  }

  private async ensureWorkspaceScheduleRunColumns(): Promise<void> {
    await this.ensureColumn('workspace_schedule_runs', 'conversationId', (table) =>
      table.uuid('conversationId').references('id').inTable('conversations').onDelete('SET NULL'));
    await this.ensureColumn('workspace_schedule_runs', 'agentRunId', (table) => table.string('agentRunId'));
    await this.ensureColumn('workspace_schedule_runs', 'status', (table) =>
      table.string('status', 32).notNullable().defaultTo('queued'));
    await this.ensureColumn('workspace_schedule_runs', 'triggeredBy', (table) =>
      table.string('triggeredBy', 32).notNullable().defaultTo('scheduler'));
    await this.ensureColumn('workspace_schedule_runs', 'error', (table) => table.text('error'));
    await this.ensureColumn('workspace_schedule_runs', 'startedAt', (table) =>
      table.timestamp('startedAt', { useTz: true }));
    await this.ensureColumn('workspace_schedule_runs', 'completedAt', (table) =>
      table.timestamp('completedAt', { useTz: true }));
    await this.ensureColumn('workspace_schedule_runs', 'createdAt', (table) =>
      table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
    await this.ensureColumn('workspace_schedule_runs', 'updatedAt', (table) =>
      table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS workspace_schedule_runs_schedule_created_idx ON workspace_schedule_runs ("scheduleId", "createdAt")',
    );
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS workspace_schedule_runs_agent_run_idx ON workspace_schedule_runs ("agentRunId")',
    );
    await this.db.raw(
      'CREATE INDEX IF NOT EXISTS workspace_schedule_runs_status_updated_idx ON workspace_schedule_runs ("status", "updatedAt")',
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

  private async createSkillEvolutionSuggestionsTable(): Promise<void> {
    const exists = await this.db.schema.hasTable('skill_evolution_suggestions');
    if (!exists) {
      await this.db.schema.createTable('skill_evolution_suggestions', (table) => {
        table.uuid('id').primary();
        table.string('targetKind').notNullable();
        table.uuid('memoryUserId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.text('memoryTargetPath');
        table.string('targetSkillId');
        table.uuid('workspaceId').references('id').inTable('workspaces').onDelete('SET NULL');
        table.jsonb('evidence').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.text('rationale').notNullable();
        table.string('baseContentHash').notNullable();
        table.text('baseContentSnapshot');
        table.text('proposedContent').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.text('reviewedContent');
        table.timestamp('reviewedAt', { useTz: true });
        table.uuid('reviewedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['status', 'createdAt'], 'skill_evolution_suggestions_status_created_idx');
        table.index(['memoryUserId', 'status'], 'skill_evolution_suggestions_user_status_idx');
      });
      console.log('Created "skill_evolution_suggestions" table.');
    } else {
      await this.ensureColumn('skill_evolution_suggestions', 'targetKind', (table) => table.string('targetKind').notNullable());
      await this.ensureColumn('skill_evolution_suggestions', 'memoryUserId', (table) =>
        table.uuid('memoryUserId').notNullable().references('id').inTable('users').onDelete('CASCADE'));
      await this.ensureColumn('skill_evolution_suggestions', 'memoryTargetPath', (table) => table.text('memoryTargetPath'));
      await this.ensureColumn('skill_evolution_suggestions', 'targetSkillId', (table) => table.string('targetSkillId'));
      await this.ensureColumn('skill_evolution_suggestions', 'workspaceId', (table) =>
        table.uuid('workspaceId').references('id').inTable('workspaces').onDelete('SET NULL'));
      await this.ensureColumn('skill_evolution_suggestions', 'evidence', (table) =>
        table.jsonb('evidence').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`)));
      await this.ensureColumn('skill_evolution_suggestions', 'rationale', (table) => table.text('rationale').notNullable());
      await this.ensureColumn('skill_evolution_suggestions', 'baseContentHash', (table) => table.string('baseContentHash').notNullable());
      await this.ensureColumn('skill_evolution_suggestions', 'baseContentSnapshot', (table) => table.text('baseContentSnapshot'));
      await this.ensureColumn('skill_evolution_suggestions', 'proposedContent', (table) => table.text('proposedContent').notNullable());
      await this.ensureColumn('skill_evolution_suggestions', 'status', (table) =>
        table.string('status').notNullable().defaultTo('pending'));
      await this.ensureColumn('skill_evolution_suggestions', 'reviewedContent', (table) => table.text('reviewedContent'));
      await this.ensureColumn('skill_evolution_suggestions', 'reviewedAt', (table) =>
        table.timestamp('reviewedAt', { useTz: true }));
      await this.ensureColumn('skill_evolution_suggestions', 'reviewedByUserId', (table) =>
        table.uuid('reviewedByUserId').references('id').inTable('users').onDelete('SET NULL'));
      await this.ensureColumn('skill_evolution_suggestions', 'createdAt', (table) =>
        table.timestamp('createdAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.ensureColumn('skill_evolution_suggestions', 'updatedAt', (table) =>
        table.timestamp('updatedAt', { useTz: true }).defaultTo(this.db.fn.now()));
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS skill_evolution_suggestions_status_created_idx ON skill_evolution_suggestions ("status", "createdAt")',
      );
      await this.db.raw(
        'CREATE INDEX IF NOT EXISTS skill_evolution_suggestions_user_status_idx ON skill_evolution_suggestions ("memoryUserId", "status")',
      );
    }
  }

  /**
   * Governed-skill and scoped-role persistence.
   *
   * HelpUDoc historically bootstraps its schema in-process instead of using a
   * migration runner. Keep that convention here, but keep the tables
   * domain-specific so their ownership and privacy invariants remain explicit.
   */
  private async createUnifiedGovernanceTables(): Promise<void> {
    await this.ensureColumn('workspaces', 'workspaceType', (table) =>
      table.string('workspaceType', 16).notNullable().defaultTo('private'));
    await this.ensureColumn('workspaces', 'editingPolicy', (table) =>
      table.string('editingPolicy', 16));
    await this.ensureColumn('workspaces', 'status', (table) =>
      table.string('status', 16).notNullable().defaultTo('active'));

    await this.db.raw(`
      UPDATE workspaces
      SET "workspaceType" = CASE WHEN visibility = 'team' THEN 'team' ELSE 'private' END,
          "editingPolicy" = CASE
            WHEN visibility = 'team' THEN COALESCE("editingPolicy", 'review')
            ELSE NULL
          END
    `);

    if (!await this.db.schema.hasTable('platform_role_bindings')) {
      await this.db.schema.createTable('platform_role_bindings', (table) => {
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('role', 32).notNullable();
        table.uuid('assignedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['userId', 'role']);
      });
    }

    if (!await this.db.schema.hasTable('team_role_bindings')) {
      await this.db.schema.createTable('team_role_bindings', (table) => {
        table.uuid('teamId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('role', 32).notNullable();
        table.uuid('assignedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['teamId', 'userId', 'role']);
        table.index(['userId', 'teamId', 'role'], 'team_role_bindings_user_team_role_idx');
      });
    }

    if (!await this.db.schema.hasTable('workspace_user_grants')) {
      await this.db.schema.createTable('workspace_user_grants', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('role', 32).notNullable();
        table.uuid('grantedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'userId']);
        table.index(['userId', 'workspaceId', 'role'], 'workspace_user_grants_user_workspace_role_idx');
      });
    }

    if (!await this.db.schema.hasTable('workspace_team_grants')) {
      await this.db.schema.createTable('workspace_team_grants', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('teamId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.string('role', 32).notNullable();
        table.uuid('grantedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'teamId']);
        table.index(['teamId', 'workspaceId', 'role'], 'workspace_team_grants_team_workspace_role_idx');
      });
    }

    if (!await this.db.schema.hasTable('content_blobs')) {
      await this.db.schema.createTable('content_blobs', (table) => {
        table.string('contentHash', 64).primary();
        table.string('storageProvider', 32).notNullable().defaultTo('local');
        table.text('storageKey').notNullable().unique();
        table.bigInteger('sizeBytes').notNullable();
        table.string('mimeType', 255);
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
      });
    }

    if (!await this.db.schema.hasTable('private_skill_drafts')) {
      await this.db.schema.createTable('private_skill_drafts', (table) => {
        table.uuid('id').primary();
        table.uuid('ownerUserId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('proposalType', 16).notNullable();
        table.uuid('sourceSkillId');
        table.uuid('sourceVersionId');
        table.uuid('proposedOwnerTeamId').references('id').inTable('groups').onDelete('SET NULL');
        table.string('proposedSkillKey', 128);
        table.string('displayName');
        table.text('description');
        table.uuid('currentDraftRevisionId');
        table.bigInteger('draftRevision').notNullable().defaultTo(0);
        table.string('status', 24).notNullable().defaultTo('private');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['ownerUserId', 'status', 'updatedAt'], 'private_skill_drafts_owner_status_updated_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_draft_revisions')) {
      await this.db.schema.createTable('skill_draft_revisions', (table) => {
        table.uuid('id').primary();
        table.uuid('draftId').notNullable().references('id').inTable('private_skill_drafts').onDelete('CASCADE');
        table.bigInteger('revisionNumber').notNullable();
        table.uuid('parentRevisionId');
        table.string('manifestHash', 64).notNullable();
        table.jsonb('validationSummary').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.uuid('createdByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['draftId', 'revisionNumber']);
      });
    }

    if (!await this.db.schema.hasTable('skill_draft_revision_files')) {
      await this.db.schema.createTable('skill_draft_revision_files', (table) => {
        table.uuid('draftRevisionId').notNullable().references('id').inTable('skill_draft_revisions').onDelete('CASCADE');
        table.text('path').notNullable();
        table.string('contentHash', 64).notNullable().references('contentHash').inTable('content_blobs').onDelete('RESTRICT');
        table.integer('mode').notNullable().defaultTo(420);
        table.bigInteger('sizeBytes').notNullable();
        table.string('mimeType', 255);
        table.primary(['draftRevisionId', 'path']);
      });
    }

    if (!await this.db.schema.hasTable('skills')) {
      await this.db.schema.createTable('skills', (table) => {
        table.uuid('id').primary();
        table.string('skillKey', 128).notNullable().unique();
        table.string('displayName').notNullable();
        table.text('description');
        table.uuid('ownerTeamId').notNullable().references('id').inTable('groups').onDelete('RESTRICT');
        table.uuid('originalCreatorUserId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('defaultVersionId');
        table.string('status', 24).notNullable().defaultTo('active');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['ownerTeamId', 'status'], 'skills_owner_team_status_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_review_requests')) {
      await this.db.schema.createTable('skill_review_requests', (table) => {
        table.uuid('id').primary();
        table.uuid('draftId').notNullable().references('id').inTable('private_skill_drafts').onDelete('RESTRICT');
        table.string('proposalType', 16).notNullable();
        table.uuid('ownerTeamId').notNullable().references('id').inTable('groups').onDelete('RESTRICT');
        table.uuid('targetSkillId').references('id').inTable('skills').onDelete('RESTRICT');
        table.uuid('proposerUserId').notNullable().references('id').inTable('users').onDelete('RESTRICT');
        table.string('status', 24).notNullable().defaultTo('submitted');
        table.uuid('currentCandidateId');
        table.bigInteger('requestRevision').notNullable().defaultTo(1);
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['ownerTeamId', 'status', 'updatedAt'], 'skill_review_requests_team_status_updated_idx');
        table.index(['proposerUserId', 'status', 'updatedAt'], 'skill_review_requests_proposer_status_updated_idx');
      });
    }
    await this.ensureColumn('skill_review_requests', 'activationStatus', (table) =>
      table.string('activationStatus', 24));
    await this.ensureColumn('skill_review_requests', 'activationErrorCode', (table) =>
      table.string('activationErrorCode', 64));

    if (!await this.db.schema.hasTable('skill_review_candidates')) {
      await this.db.schema.createTable('skill_review_candidates', (table) => {
        table.uuid('id').primary();
        table.uuid('requestId').notNullable().references('id').inTable('skill_review_requests').onDelete('CASCADE');
        table.integer('candidateNumber').notNullable();
        table.uuid('sourceDraftRevisionId').notNullable().references('id').inTable('skill_draft_revisions').onDelete('RESTRICT');
        table.string('skillKey', 128).notNullable();
        table.string('semanticVersion', 64).notNullable();
        table.uuid('sourceSkillId').references('id').inTable('skills').onDelete('RESTRICT');
        table.uuid('sourceVersionId');
        table.string('manifestHash', 64).notNullable();
        table.text('submissionNote');
        table.jsonb('validationSummary').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.jsonb('riskSummary').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.uuid('submittedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('submittedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['requestId', 'candidateNumber']);
        table.index(['requestId', 'submittedAt'], 'skill_review_candidates_request_submitted_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_review_candidate_files')) {
      await this.db.schema.createTable('skill_review_candidate_files', (table) => {
        table.uuid('candidateId').notNullable().references('id').inTable('skill_review_candidates').onDelete('CASCADE');
        table.text('path').notNullable();
        table.string('contentHash', 64).notNullable().references('contentHash').inTable('content_blobs').onDelete('RESTRICT');
        table.integer('mode').notNullable().defaultTo(420);
        table.bigInteger('sizeBytes').notNullable();
        table.string('mimeType', 255);
        table.primary(['candidateId', 'path']);
      });
    }

    if (!await this.db.schema.hasTable('skill_candidate_policy_results')) {
      await this.db.schema.createTable('skill_candidate_policy_results', (table) => {
        table.uuid('id').primary();
        table.uuid('candidateId').notNullable().references('id').inTable('skill_review_candidates').onDelete('CASCADE');
        table.string('policyVersion', 64).notNullable();
        table.string('outcome', 16).notNullable();
        table.string('riskClass', 32).notNullable();
        table.jsonb('issues').notNullable().defaultTo(this.db.raw(`'[]'::jsonb`));
        table.jsonb('validationSummary').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.timestamp('evaluatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['candidateId', 'evaluatedAt'], 'skill_candidate_policy_candidate_evaluated_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_review_decisions')) {
      await this.db.schema.createTable('skill_review_decisions', (table) => {
        table.uuid('id').primary();
        table.uuid('requestId').notNullable().references('id').inTable('skill_review_requests').onDelete('CASCADE');
        table.uuid('candidateId').notNullable().references('id').inTable('skill_review_candidates').onDelete('RESTRICT');
        table.string('decision', 24).notNullable();
        table.uuid('reviewerUserId').references('id').inTable('users').onDelete('SET NULL');
        table.string('reviewerRole', 32).notNullable().defaultTo('team_lead');
        table.text('comment');
        table.string('policyVersion', 64).notNullable();
        table.boolean('selfApproved').notNullable().defaultTo(false);
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['requestId', 'createdAt'], 'skill_review_decisions_request_created_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_versions')) {
      await this.db.schema.createTable('skill_versions', (table) => {
        table.uuid('id').primary();
        table.uuid('skillId').notNullable().references('id').inTable('skills').onDelete('RESTRICT');
        table.string('semanticVersion', 64).notNullable();
        table.string('manifestHash', 64).notNullable();
        table.uuid('baseVersionId');
        table.string('status', 24).notNullable().defaultTo('active');
        table.uuid('createdByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.uuid('approvedCandidateId').references('id').inTable('skill_review_candidates').onDelete('RESTRICT');
        table.jsonb('validationSummary').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.text('materializedPath');
        table.timestamp('activatedAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.unique(['skillId', 'semanticVersion']);
        table.unique(['skillId', 'id', 'semanticVersion', 'manifestHash']);
        table.index(['skillId', 'status', 'semanticVersion'], 'skill_versions_skill_status_semver_idx');
      });
    }

    if (!await this.db.schema.hasTable('skill_version_files')) {
      await this.db.schema.createTable('skill_version_files', (table) => {
        table.uuid('skillVersionId').notNullable().references('id').inTable('skill_versions').onDelete('RESTRICT');
        table.text('path').notNullable();
        table.string('contentHash', 64).notNullable().references('contentHash').inTable('content_blobs').onDelete('RESTRICT');
        table.boolean('executable').notNullable().defaultTo(false);
        table.integer('mode').notNullable().defaultTo(420);
        table.bigInteger('sizeBytes').notNullable();
        table.string('mimeType', 255);
        table.primary(['skillVersionId', 'path']);
      });
    }

    if (!await this.db.schema.hasTable('team_skill_grants')) {
      await this.db.schema.createTable('team_skill_grants', (table) => {
        table.uuid('teamId').notNullable().references('id').inTable('groups').onDelete('CASCADE');
        table.uuid('skillId').notNullable().references('id').inTable('skills').onDelete('CASCADE');
        table.string('effect', 16).notNullable().defaultTo('allow');
        table.uuid('grantedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['teamId', 'skillId']);
      });
    }

    if (!await this.db.schema.hasTable('user_skill_grants')) {
      await this.db.schema.createTable('user_skill_grants', (table) => {
        table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('skillId').notNullable().references('id').inTable('skills').onDelete('CASCADE');
        table.string('effect', 16).notNullable().defaultTo('allow');
        table.uuid('grantedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['userId', 'skillId']);
      });
    }

    if (!await this.db.schema.hasTable('workspace_skill_pins')) {
      await this.db.schema.createTable('workspace_skill_pins', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('skillId').notNullable().references('id').inTable('skills').onDelete('RESTRICT');
        table.uuid('skillVersionId').notNullable().references('id').inTable('skill_versions').onDelete('RESTRICT');
        table.string('semanticVersion', 64).notNullable();
        table.string('manifestHash', 64).notNullable();
        table.uuid('pinnedByUserId').references('id').inTable('users').onDelete('SET NULL');
        table.string('validationStatus', 24).notNullable().defaultTo('valid');
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'skillId']);
      });
    }

    if (!await this.db.schema.hasTable('private_workspace_skill_draft_pins')) {
      await this.db.schema.createTable('private_workspace_skill_draft_pins', (table) => {
        table.uuid('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
        table.uuid('draftId').notNullable().references('id').inTable('private_skill_drafts').onDelete('CASCADE');
        table.uuid('draftRevisionId').notNullable().references('id').inTable('skill_draft_revisions').onDelete('RESTRICT');
        table.timestamp('pinnedAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.primary(['workspaceId', 'draftId']);
      });
    }

    if (!await this.db.schema.hasTable('published_version_skill_pins')) {
      await this.db.schema.createTable('published_version_skill_pins', (table) => {
        table.uuid('publishedVersionId').notNullable().references('id').inTable('workspace_published_versions').onDelete('CASCADE');
        table.uuid('skillId').notNullable().references('id').inTable('skills').onDelete('RESTRICT');
        table.uuid('skillVersionId').notNullable().references('id').inTable('skill_versions').onDelete('RESTRICT');
        table.string('semanticVersion', 64).notNullable();
        table.string('manifestHash', 64).notNullable();
        table.primary(['publishedVersionId', 'skillId']);
      });
    }

    if (!await this.db.schema.hasTable('audit_events')) {
      await this.db.schema.createTable('audit_events', (table) => {
        table.uuid('id').primary();
        table.uuid('actorUserId').references('id').inTable('users').onDelete('SET NULL');
        table.string('actorRole', 64);
        table.string('action', 96).notNullable();
        table.string('resourceType', 64).notNullable();
        table.string('resourceId', 160).notNullable();
        table.string('previousStateHash', 64);
        table.string('newStateHash', 64);
        table.text('reason');
        table.string('policyVersion', 64);
        table.string('requestId', 160);
        table.boolean('platformOverride').notNullable().defaultTo(false);
        table.boolean('selfApproved').notNullable().defaultTo(false);
        table.jsonb('metadata').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['resourceType', 'resourceId', 'createdAt'], 'audit_events_resource_created_idx');
      });
    }

    if (!await this.db.schema.hasTable('idempotency_records')) {
      await this.db.schema.createTable('idempotency_records', (table) => {
        table.uuid('actorUserId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('action', 128).notNullable();
        table.string('idempotencyKey', 255).notNullable();
        table.string('requestHash', 64).notNullable();
        table.jsonb('responseBody').notNullable();
        table.integer('responseStatus').notNullable();
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.timestamp('expiresAt', { useTz: true }).notNullable();
        table.primary(['actorUserId', 'action', 'idempotencyKey']);
      });
    }

    if (!await this.db.schema.hasTable('notifications')) {
      await this.db.schema.createTable('notifications', (table) => {
        table.uuid('id').primary();
        table.uuid('recipientUserId').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('eventType', 96).notNullable();
        table.string('resourceType', 64).notNullable();
        table.string('resourceId', 160).notNullable();
        table.jsonb('payload').notNullable().defaultTo(this.db.raw(`'{}'::jsonb`));
        table.timestamp('readAt', { useTz: true });
        table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(this.db.fn.now());
        table.index(['recipientUserId', 'readAt', 'createdAt'], 'notifications_recipient_read_created_idx');
      });
    }

    await this.createUnifiedGovernanceConstraints();

    // Compatibility backfills. They add bindings/grants without changing the
    // legacy read path; governed services become authoritative as clients move.
    await this.db.raw(`
      INSERT INTO platform_role_bindings ("userId", role, "createdAt")
      SELECT id, 'platform_admin', NOW()
      FROM users
      WHERE "isAdmin" = TRUE
      ON CONFLICT ("userId", role) DO NOTHING
    `);
    await this.db.raw(`
      INSERT INTO workspace_user_grants
        ("workspaceId", "userId", role, "grantedByUserId", "createdAt", "updatedAt")
      SELECT wm."workspaceId", wm."userId",
        CASE wm.role
          WHEN 'editor' THEN 'publisher'
          WHEN 'publisher' THEN 'publisher'
          WHEN 'contributor' THEN 'contributor'
          ELSE 'viewer'
        END,
        w."ownerId", wm."createdAt", wm."updatedAt"
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm."workspaceId"
      WHERE wm."userId" <> w."ownerId" AND w."workspaceType" = 'team'
      ON CONFLICT ("workspaceId", "userId") DO NOTHING
    `);
    await this.db.raw(`
      INSERT INTO workspace_team_grants
        ("workspaceId", "teamId", role, "grantedByUserId", "createdAt", "updatedAt")
      SELECT id, "teamId", 'viewer', "ownerId", NOW(), NOW()
      FROM workspaces
      WHERE "workspaceType" = 'team' AND "teamId" IS NOT NULL
      ON CONFLICT ("workspaceId", "teamId") DO NOTHING
    `);
  }

  private async createUnifiedGovernanceConstraints(): Promise<void> {
    await this.db.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS skill_versions_skill_id_id_unique
        ON skill_versions ("skillId", id);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_review_candidates_request_id_id_unique
        ON skill_review_candidates ("requestId", id);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_draft_revisions_draft_id_id_unique
        ON skill_draft_revisions ("draftId", id);
    `);
    await this.db.raw(`
      DO $governance$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'skills_default_version_same_skill_fk'
        ) THEN
          ALTER TABLE skills
            ADD CONSTRAINT skills_default_version_same_skill_fk
            FOREIGN KEY (id, "defaultVersionId")
            REFERENCES skill_versions ("skillId", id)
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'skill_versions_base_same_skill_fk'
        ) THEN
          ALTER TABLE skill_versions
            ADD CONSTRAINT skill_versions_base_same_skill_fk
            FOREIGN KEY ("skillId", "baseVersionId")
            REFERENCES skill_versions ("skillId", id)
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'private_skill_drafts_current_revision_fk'
        ) THEN
          ALTER TABLE private_skill_drafts
            ADD CONSTRAINT private_skill_drafts_current_revision_fk
            FOREIGN KEY (id, "currentDraftRevisionId")
            REFERENCES skill_draft_revisions ("draftId", id)
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'skill_review_requests_current_candidate_fk'
        ) THEN
          ALTER TABLE skill_review_requests
            ADD CONSTRAINT skill_review_requests_current_candidate_fk
            FOREIGN KEY (id, "currentCandidateId")
            REFERENCES skill_review_candidates ("requestId", id)
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'workspace_skill_pins_exact_version_fk'
        ) THEN
          ALTER TABLE workspace_skill_pins
            ADD CONSTRAINT workspace_skill_pins_exact_version_fk
            FOREIGN KEY ("skillId", "skillVersionId", "semanticVersion", "manifestHash")
            REFERENCES skill_versions ("skillId", id, "semanticVersion", "manifestHash")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'private_workspace_skill_draft_pins_exact_revision_fk'
        ) THEN
          ALTER TABLE private_workspace_skill_draft_pins
            ADD CONSTRAINT private_workspace_skill_draft_pins_exact_revision_fk
            FOREIGN KEY ("draftId", "draftRevisionId")
            REFERENCES skill_draft_revisions ("draftId", id)
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'published_version_skill_pins_exact_version_fk'
        ) THEN
          ALTER TABLE published_version_skill_pins
            ADD CONSTRAINT published_version_skill_pins_exact_version_fk
            FOREIGN KEY ("skillId", "skillVersionId", "semanticVersion", "manifestHash")
            REFERENCES skill_versions ("skillId", id, "semanticVersion", "manifestHash")
            ON DELETE RESTRICT;
        END IF;
      END
      $governance$;
    `);
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
