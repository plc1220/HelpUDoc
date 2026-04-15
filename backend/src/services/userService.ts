import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';

export interface UserRecord {
  id: string;
  externalId: string;
  email?: string | null;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupPromptAccess {
  skillIds: string[];
  mcpServerIds: string[];
}

export interface EffectivePromptAccess extends GroupPromptAccess {
  isAdmin: boolean;
}

export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string | null;
}

export interface UserDeletionImpact {
  user: Pick<UserRecord, 'id' | 'displayName' | 'email' | 'externalId' | 'isAdmin'>;
  ownedWorkspaces: Array<{ id: string; name: string }>;
  sharedWorkspaceCount: number;
  groupMembershipCount: number;
  oauthTokenCount: number;
  authoredFileCount: number;
  authoredKnowledgeCount: number;
  authoredConversationCount: number;
  authoredMessageCount: number;
}

interface UserProfileInput {
  externalId: string;
  displayName?: string | null;
  email?: string | null;
}

const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || null;
const normalizeUniqueStrings = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

const parseAdminEmails = () => new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

export class UserService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async ensureUser(profile: UserProfileInput): Promise<UserRecord> {
    const normalizedExternalId = profile.externalId.trim().toLowerCase();
    const displayName = (profile.displayName || profile.externalId).trim();
    const email = normalizeEmail(profile.email);
    const adminEmails = parseAdminEmails();

    const existing = await this.db<UserRecord>('users').where({ externalId: normalizedExternalId }).first();
    if (!existing) {
      const isAdmin = !!(email && adminEmails.has(email));
      const [created] = await this.db<UserRecord>('users')
        .insert({
          id: uuidv4(),
          externalId: normalizedExternalId,
          displayName,
          email,
          isAdmin,
        })
        .returning('*');
      return created;
    }

    const updates: Partial<UserRecord> = {};
    if (displayName && displayName !== existing.displayName) {
      updates.displayName = displayName;
    }
    if (email !== existing.email) {
      updates.email = email;
    }

    if (!existing.isAdmin && email && adminEmails.has(email)) {
      updates.isAdmin = true;
    }

    if (Object.keys(updates).length) {
      const [updated] = await this.db<UserRecord>('users')
        .where({ id: existing.id })
        .update({
          ...updates,
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      return updated;
    }

    return existing;
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.db<UserRecord>('users')
      .select('*')
      .orderBy('createdAt', 'asc');
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.db<UserRecord>('users').where({ id: userId }).first();
    return user || null;
  }

  /**
   * Prefix search for workspace sharing picker. Requires at least two non-space characters.
   */
  async searchUsersForDirectory(
    query: string,
    options: { limit: number; excludeUserId?: string },
  ): Promise<DirectoryUser[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      return [];
    }
    const limit = Math.min(Math.max(options.limit, 1), 50);
    const pattern = `%${trimmed.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    let builder = this.db<UserRecord>('users')
      .select('id', 'displayName', 'email')
      .where((qb) => {
        qb.where('displayName', 'ilike', pattern).orWhere('email', 'ilike', pattern);
      })
      .orderBy('displayName', 'asc')
      .limit(limit);

    if (options.excludeUserId) {
      builder = builder.andWhere('id', '!=', options.excludeUserId);
    }

    const rows = await builder;
    return (rows as UserRecord[]).map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email ?? null,
    }));
  }

  async setUserAdmin(userId: string, isAdmin: boolean): Promise<UserRecord | null> {
    const [updated] = await this.db<UserRecord>('users')
      .where({ id: userId })
      .update({
        isAdmin,
        updatedAt: this.db.fn.now(),
      })
      .returning('*');

    return updated || null;
  }

  async listGroups(): Promise<GroupRecord[]> {
    return this.db<GroupRecord>('groups')
      .select('*')
      .orderBy('name', 'asc');
  }

  async getGroupById(groupId: string): Promise<GroupRecord | null> {
    const group = await this.db<GroupRecord>('groups').where({ id: groupId }).first();
    return group || null;
  }

  async createGroup(name: string): Promise<GroupRecord> {
    const [group] = await this.db<GroupRecord>('groups')
      .insert({
        id: uuidv4(),
        name: name.trim(),
      })
      .returning('*');
    return group;
  }

  async deleteGroup(groupId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx('skill_grants').where({ principalType: 'group', principalId: groupId }).del();
      await tx('mcp_server_group_grants').where({ groupId }).del();
      const deleted = await tx<GroupRecord>('groups').where({ id: groupId }).del();
      return Number(deleted || 0);
    });
  }

  async listGroupMembers(groupId: string): Promise<UserRecord[]> {
    return this.db<UserRecord>('users as u')
      .join('group_members as gm', 'u.id', 'gm.userId')
      .where('gm.groupId', groupId)
      .select('u.*')
      .orderBy('u.displayName', 'asc');
  }

  async addGroupMember(groupId: string, userId: string): Promise<void> {
    await this.db('group_members')
      .insert({
        groupId,
        userId,
      })
      .onConflict(['groupId', 'userId'])
      .ignore();
  }

  async removeGroupMember(groupId: string, userId: string): Promise<number> {
    return this.db('group_members').where({ groupId, userId }).del();
  }

  async getGroupPromptAccess(groupId: string): Promise<GroupPromptAccess | null> {
    const group = await this.getGroupById(groupId);
    if (!group) {
      return null;
    }
    const [skillRows, mcpRows] = await Promise.all([
      this.db('skill_grants')
        .select('skillId')
        .where({ principalType: 'group', principalId: groupId, effect: 'allow' }),
      this.db('mcp_server_group_grants')
        .select('serverId')
        .where({ groupId }),
    ]);

    return {
      skillIds: normalizeUniqueStrings((skillRows as Array<{ skillId?: string }>).map((row) => String(row.skillId || ''))),
      mcpServerIds: normalizeUniqueStrings((mcpRows as Array<{ serverId?: string }>).map((row) => String(row.serverId || ''))),
    };
  }

  async replaceGroupPromptAccess(groupId: string, access: GroupPromptAccess): Promise<GroupPromptAccess | null> {
    const skillIds = normalizeUniqueStrings(access.skillIds || []);
    const mcpServerIds = normalizeUniqueStrings(access.mcpServerIds || []);

    return this.db.transaction(async (tx) => {
      const group = await tx<GroupRecord>('groups').where({ id: groupId }).first();
      if (!group) {
        return null;
      }

      await tx('skill_grants').where({ principalType: 'group', principalId: groupId }).del();
      if (skillIds.length) {
        await tx('skill_grants').insert(
          skillIds.map((skillId) => ({
            principalType: 'group',
            principalId: groupId,
            skillId,
            effect: 'allow',
          })),
        );
      }

      await tx('mcp_server_group_grants').where({ groupId }).del();
      if (mcpServerIds.length) {
        await tx('mcp_server_group_grants').insert(
          mcpServerIds.map((serverId) => ({
            groupId,
            serverId,
          })),
        );
      }

      return {
        skillIds,
        mcpServerIds,
      };
    });
  }

  async getEffectivePromptAccess(userId: string): Promise<EffectivePromptAccess | null> {
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }
    if (user.isAdmin) {
      return {
        isAdmin: true,
        skillIds: [],
        mcpServerIds: [],
      };
    }

    const memberships = await this.db('group_members').select('groupId').where({ userId });
    const groupIds = normalizeUniqueStrings((memberships as Array<{ groupId?: string }>).map((row) => String(row.groupId || '')));
    if (!groupIds.length) {
      return {
        isAdmin: false,
        skillIds: [],
        mcpServerIds: [],
      };
    }

    const [skillRows, mcpRows] = await Promise.all([
      this.db('skill_grants')
        .select('skillId')
        .where({ principalType: 'group', effect: 'allow' })
        .whereIn('principalId', groupIds),
      this.db('mcp_server_group_grants')
        .select('serverId')
        .whereIn('groupId', groupIds),
    ]);

    return {
      isAdmin: false,
      skillIds: normalizeUniqueStrings((skillRows as Array<{ skillId?: string }>).map((row) => String(row.skillId || ''))),
      mcpServerIds: normalizeUniqueStrings((mcpRows as Array<{ serverId?: string }>).map((row) => String(row.serverId || ''))),
    };
  }

  async listOwnedWorkspaces(userId: string): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db('workspaces')
      .select('id', 'name')
      .where({ ownerId: userId })
      .orderBy('name', 'asc');
    return (rows as Array<{ id: string; name: string }>).map((row) => ({ id: row.id, name: row.name }));
  }

  async getUserDeletionImpact(userId: string): Promise<UserDeletionImpact | null> {
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }

    const ownedWorkspaces = await this.listOwnedWorkspaces(userId);
    const [sharedWorkspaceCount, groupMembershipCount, oauthTokenCount, authoredFileCount, authoredKnowledgeCount, authoredConversationCount, authoredMessageCount] = await Promise.all([
      this.countSharedWorkspaceMemberships(userId),
      this.countRows('group_members', { userId }),
      this.countRows('user_oauth_tokens', { userId }),
      this.countDistinctReferences('files', 'id', ['createdBy', 'updatedBy'], userId),
      this.countDistinctReferences('knowledge_sources', 'id', ['createdBy', 'updatedBy'], userId),
      this.countDistinctReferences('conversations', 'id', ['createdBy', 'updatedBy'], userId),
      this.countDistinctReferences('conversation_messages', 'id', ['authorId'], userId),
    ]);

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        externalId: user.externalId,
        isAdmin: user.isAdmin,
      },
      ownedWorkspaces,
      sharedWorkspaceCount,
      groupMembershipCount,
      oauthTokenCount,
      authoredFileCount,
      authoredKnowledgeCount,
      authoredConversationCount,
      authoredMessageCount,
    };
  }

  async deleteUser(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await this.detachUserReferences(tx, userId);
      await tx('group_members').where({ userId }).del();
      await tx('workspace_members').where({ userId }).del();
      await tx('user_oauth_tokens').where({ userId }).del();
      await tx('mcp_server_grants').where({ userId }).del();
      await tx('skill_grants').where({ principalType: 'user', principalId: userId }).del();
      await tx('mcp_connection_grants').where({ principalType: 'user', principalId: userId }).del();
      await tx<UserRecord>('users').where({ id: userId }).del();
    });

    return true;
  }

  private async detachUserReferences(tx: Knex.Transaction, userId: string): Promise<void> {
    await Promise.all([
      tx('workspaces').where({ lastModifiedBy: userId }).update({ lastModifiedBy: null, updatedAt: this.db.fn.now() }),
      tx('files').where({ createdBy: userId }).update({ createdBy: null, updatedAt: this.db.fn.now() }),
      tx('files').where({ updatedBy: userId }).update({ updatedBy: null, updatedAt: this.db.fn.now() }),
      tx('knowledge_sources').where({ createdBy: userId }).update({ createdBy: null, updatedAt: this.db.fn.now() }),
      tx('knowledge_sources').where({ updatedBy: userId }).update({ updatedBy: null, updatedAt: this.db.fn.now() }),
      tx('conversations').where({ createdBy: userId }).update({ createdBy: null, updatedAt: this.db.fn.now() }),
      tx('conversations').where({ updatedBy: userId }).update({ updatedBy: null, updatedAt: this.db.fn.now() }),
      tx('conversation_messages').where({ authorId: userId }).update({ authorId: null, updatedAt: this.db.fn.now() }),
    ]);
  }

  private async countRows(tableName: string, where: Record<string, unknown>): Promise<number> {
    const row = await this.db(tableName).where(where).count<{ count: string }>('count(*) as count').first();
    return Number(row?.count || 0);
  }

  private async countSharedWorkspaceMemberships(userId: string): Promise<number> {
    const row = await this.db('workspace_members as wm')
      .join('workspaces as w', 'wm.workspaceId', 'w.id')
      .where('wm.userId', userId)
      .andWhere('w.ownerId', '<>', userId)
      .count<{ count: string }>('wm.workspaceId as count')
      .first();
    return Number(row?.count || 0);
  }

  private async countDistinctReferences(
    tableName: string,
    idColumn: string,
    referenceColumns: string[],
    userId: string,
  ): Promise<number> {
    if (!referenceColumns.length) {
      return 0;
    }

    const query = this.db(tableName).where((builder) => {
      referenceColumns.forEach((column, index) => {
        if (index === 0) {
          builder.where(column, userId);
        } else {
          builder.orWhere(column, userId);
        }
      });
    });

    const row = await query.countDistinct<{ count: string }>(`${idColumn} as count`).first();
    return Number(row?.count || 0);
  }
}
