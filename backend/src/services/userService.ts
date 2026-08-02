import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { ConflictError } from '../errors';

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
  knowledgeSourceIds: number[];
}

export interface EffectivePromptAccess extends GroupPromptAccess {
  isAdmin: boolean;
}

export interface WorkspaceSkillRuntimePin {
  skillId: string;
  skillKey: string;
  versionId: string;
  semanticVersion: string;
  manifestHash: string;
  available: boolean;
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
const normalizeUniqueNumbers = (values: number[]) => Array.from(new Set(
  values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
)).sort((a, b) => a - b);

export type UserSortField = 'displayName' | 'email' | 'role' | 'createdAt';
export type UserSortOrder = 'asc' | 'desc';

export interface UserPage {
  users: UserRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

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
        .onConflict('externalId')
        .ignore()
        .returning('*');
      if (!created) {
        // Initial page loads issue several authenticated requests in parallel.
        // Let the request that lost the insert race reuse the newly created row.
        return this.ensureUser(profile);
      }
      if (created.isAdmin) {
        await this.db('platform_role_bindings').insert({
          userId: created.id,
          role: 'platform_admin',
        }).onConflict(['userId', 'role']).ignore();
      }
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
      if (updated.isAdmin) {
        await this.db('platform_role_bindings').insert({
          userId: updated.id,
          role: 'platform_admin',
        }).onConflict(['userId', 'role']).ignore();
      }
      return updated;
    }

    return existing;
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.db<UserRecord>('users')
      .select('*')
      .orderBy('createdAt', 'asc');
  }

  async listUsersPage(options: {
    page: number;
    pageSize: number;
    sortBy: UserSortField;
    sortOrder: UserSortOrder;
    search?: string;
  }): Promise<UserPage> {
    const pageSize = Math.min(Math.max(Math.trunc(options.pageSize), 5), 100);
    const requestedPage = Math.max(Math.trunc(options.page), 1);
    const search = String(options.search || '').trim();
    const sortColumns: Record<UserSortField, string> = {
      displayName: 'displayName',
      email: 'email',
      role: 'isAdmin',
      createdAt: 'createdAt',
    };

    const applySearch = <T extends Knex.QueryBuilder>(query: T): T => {
      if (!search) return query;
      const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      return query.where((builder) => {
        builder
          .where('displayName', 'ilike', pattern)
          .orWhere('email', 'ilike', pattern)
          .orWhere('externalId', 'ilike', pattern);
      }) as T;
    };

    const countRow = await applySearch(this.db('users'))
      .count<{ count: string }>('id as count')
      .first();
    const total = Number(countRow?.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const sortColumn = sortColumns[options.sortBy];

    const users = await applySearch(this.db<UserRecord>('users').select('*'))
      .orderBy(sortColumn, options.sortOrder, options.sortBy === 'email' ? 'last' : undefined)
      .orderBy('id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { users, total, page, pageSize, totalPages };
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
    return this.db.transaction(async (tx) => {
      const target = await tx<UserRecord>('users').where({ id: userId }).forUpdate().first();
      if (!target) return null;
      if (target.isAdmin && !isAdmin) {
        const activeAdmins = await tx<UserRecord>('users')
          .where({ isAdmin: true })
          .forUpdate();
        if (activeAdmins.length <= 1) {
          throw new ConflictError('The final active Platform Admin cannot be removed or demoted');
        }
      }
      const [updated] = await tx<UserRecord>('users')
        .where({ id: userId })
        .update({
          isAdmin,
          updatedAt: tx.fn.now(),
        })
        .returning('*');
      if (isAdmin) {
        await tx('platform_role_bindings').insert({
          userId,
          role: 'platform_admin',
        }).onConflict(['userId', 'role']).ignore();
      } else {
        await tx('platform_role_bindings').where({ userId, role: 'platform_admin' }).del();
      }
      return updated || null;
    });
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
      const [ownedSkill, review] = await Promise.all([
        tx('skills').where({ ownerTeamId: groupId }).first(),
        tx('skill_review_requests').where({ ownerTeamId: groupId }).first(),
      ]);
      if (ownedSkill || review) {
        throw new ConflictError('A Team that owns governed skills or skill review history cannot be deleted');
      }
      await tx('skill_grants').where({ principalType: 'group', principalId: groupId }).del();
      await tx('mcp_server_group_grants').where({ groupId }).del();
      await tx('knowledge_source_group_grants').where({ groupId }).del();
      const deleted = await tx<GroupRecord>('groups').where({ id: groupId }).del();
      return Number(deleted || 0);
    });
  }

  async listGroupMembers(groupId: string): Promise<Array<UserRecord & { isTeamLead: boolean }>> {
    return this.db<UserRecord>('users as u')
      .join('group_members as gm', 'u.id', 'gm.userId')
      .leftJoin('team_role_bindings as tr', function joinTeamLead() {
        this.on('tr.teamId', '=', 'gm.groupId')
          .andOn('tr.userId', '=', 'gm.userId')
          .andOnVal('tr.role', '=', 'lead');
      })
      .where('gm.groupId', groupId)
      .select('u.*')
      .select(this.db.raw('CASE WHEN tr."userId" IS NULL THEN FALSE ELSE TRUE END AS "isTeamLead"'))
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
    return this.db.transaction(async (tx) => {
      await tx('team_role_bindings').where({ teamId: groupId, userId }).del();
      const deleted = await tx('group_members').where({ groupId, userId }).del();
      return Number(deleted || 0);
    });
  }

  async getGroupPromptAccess(groupId: string): Promise<GroupPromptAccess | null> {
    const group = await this.getGroupById(groupId);
    if (!group) {
      return null;
    }
    const [legacySkillRows, governedSkillRows, mcpRows, knowledgeRows] = await Promise.all([
      this.db('skill_grants')
        .select('skillId')
        .where({ principalType: 'group', principalId: groupId, effect: 'allow' }),
      this.db('team_skill_grants as grant')
        .join('skills as skill', 'skill.id', 'grant.skillId')
        .select('skill.skillKey as skillId')
        .where({ 'grant.teamId': groupId, 'grant.effect': 'allow' }),
      this.db('mcp_server_group_grants')
        .select('serverId')
        .where({ groupId }),
      this.db('knowledge_source_group_grants')
        .select('knowledgeSourceId')
        .where({ groupId }),
    ]);

    return {
      skillIds: normalizeUniqueStrings(
        [...legacySkillRows, ...governedSkillRows]
          .map((row: any) => String(row.skillId || '')),
      ),
      mcpServerIds: normalizeUniqueStrings((mcpRows as Array<{ serverId?: string }>).map((row) => String(row.serverId || ''))),
      knowledgeSourceIds: normalizeUniqueNumbers(
        (knowledgeRows as Array<{ knowledgeSourceId?: number }>).map((row) => Number(row.knowledgeSourceId)),
      ),
    };
  }

  async replaceGroupPromptAccess(
    groupId: string,
    access: GroupPromptAccess,
    actorUserId?: string,
  ): Promise<(GroupPromptAccess & { auditEventId?: string }) | null> {
    const skillIds = normalizeUniqueStrings(access.skillIds || []);
    const mcpServerIds = normalizeUniqueStrings(access.mcpServerIds || []);
    const knowledgeSourceIds = normalizeUniqueNumbers(access.knowledgeSourceIds || []);

    return this.db.transaction(async (tx) => {
      const group = await tx<GroupRecord>('groups').where({ id: groupId }).first();
      if (!group) {
        return null;
      }
      const previousGoverned = await tx('team_skill_grants as grant')
        .join('skills as skill', 'skill.id', 'grant.skillId')
        .select('skill.skillKey')
        .where({ 'grant.teamId': groupId, 'grant.effect': 'allow' });
      const previousMcpServers = await tx('mcp_server_group_grants')
        .select('serverId')
        .where({ groupId });

      const previousGovernedSkillKeys = previousGoverned.map((row: any) => String(row.skillKey));
      const matchingGovernedSkills = skillIds.length
        ? await tx('skills as skill')
          .leftJoin('skill_versions as version', 'version.id', 'skill.defaultVersionId')
          .select('skill.id', 'skill.skillKey', 'skill.status', 'version.status as versionStatus')
          .whereIn('skill.skillKey', skillIds)
        : [];
      const previouslyGranted = new Set(previousGovernedSkillKeys);
      const unavailableNewSkills = matchingGovernedSkills.filter((skill: any) => (
        !previouslyGranted.has(String(skill.skillKey))
        && (skill.status !== 'active' || skill.versionStatus !== 'active')
      ));
      if (unavailableNewSkills.length) {
        throw new ConflictError(
          `Archived or unavailable Team skills cannot be newly assigned: ${unavailableNewSkills.map((skill: any) => skill.skillKey).join(', ')}`,
        );
      }
      const governedSkills = matchingGovernedSkills.filter((skill: any) => (
        previouslyGranted.has(String(skill.skillKey))
        || (skill.status === 'active' && skill.versionStatus === 'active')
      ));
      const governedSkillKeys = new Set(matchingGovernedSkills.map((skill: any) => String(skill.skillKey)));
      const legacySkillIds = skillIds.filter((skillId) => !governedSkillKeys.has(skillId));

      await tx('skill_grants').where({ principalType: 'group', principalId: groupId }).del();
      if (legacySkillIds.length) {
        await tx('skill_grants').insert(
          legacySkillIds.map((skillId) => ({
            principalType: 'group',
            principalId: groupId,
            skillId,
            effect: 'allow',
          })),
        );
      }
      await tx('team_skill_grants').where({ teamId: groupId }).del();
      if (governedSkills.length) {
        await tx('team_skill_grants').insert(governedSkills.map((skill: any) => ({
          teamId: groupId,
          skillId: skill.id,
          effect: 'allow',
          grantedByUserId: actorUserId || null,
        })));
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

      await tx('knowledge_source_group_grants').where({ groupId }).del();
      if (knowledgeSourceIds.length) {
        await tx('knowledge_source_group_grants').insert(
          knowledgeSourceIds.map((knowledgeSourceId) => ({
            groupId,
            knowledgeSourceId,
          })),
        );
      }

      let auditEventId: string | undefined;
      if (actorUserId) {
        auditEventId = uuidv4();
        await tx('audit_events').insert({
          id: auditEventId,
          actorUserId,
          actorRole: 'platform_admin',
          action: 'skill_access.team_replaced',
          resourceType: 'team',
          resourceId: groupId,
          previousStateHash: null,
          newStateHash: null,
          metadata: JSON.stringify({
            previousSkillKeys: previousGoverned.map((row: any) => row.skillKey).sort(),
            skillKeys: skillIds,
            previousMcpServerIds: previousMcpServers.map((row: any) => row.serverId).sort(),
            mcpServerIds,
            knowledgeSourceIds,
          }),
        });
      }
      return {
        skillIds,
        mcpServerIds,
        knowledgeSourceIds,
        auditEventId,
      };
    });
  }

  async getEffectivePromptAccess(userId: string): Promise<EffectivePromptAccess | null> {
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }

    const memberships = await this.db('group_members').select('groupId').where({ userId });
    const groupIds = normalizeUniqueStrings((memberships as Array<{ groupId?: string }>).map((row) => String(row.groupId || '')));

    const [legacyGroupSkills, legacyDirectSkills, governedTeamSkills, governedDirectSkills, mcpRows, knowledgeRows] = await Promise.all([
      groupIds.length
        ? this.db('skill_grants as grant')
          .leftJoin('skills as governedSkill', 'governedSkill.skillKey', 'grant.skillId')
          .leftJoin('skill_versions as governedVersion', 'governedVersion.id', 'governedSkill.defaultVersionId')
          .select('grant.skillId')
          .where({ 'grant.principalType': 'group', 'grant.effect': 'allow' })
          .whereIn('grant.principalId', groupIds)
          .andWhere((builder) => {
            builder
              .whereNull('governedSkill.id')
              .orWhere((governed) => governed
                .where('governedSkill.status', 'active')
                .andWhere('governedVersion.status', 'active'));
          })
        : Promise.resolve([]),
      this.db('skill_grants as grant')
        .leftJoin('skills as governedSkill', 'governedSkill.skillKey', 'grant.skillId')
        .leftJoin('skill_versions as governedVersion', 'governedVersion.id', 'governedSkill.defaultVersionId')
        .select('grant.skillId')
        .where({ 'grant.principalType': 'user', 'grant.principalId': userId, 'grant.effect': 'allow' })
        .andWhere((builder) => {
          builder
            .whereNull('governedSkill.id')
            .orWhere((governed) => governed
              .where('governedSkill.status', 'active')
              .andWhere('governedVersion.status', 'active'));
        }),
      groupIds.length
        ? this.db('team_skill_grants as grant')
          .join('skills as skill', 'skill.id', 'grant.skillId')
          .join('skill_versions as version', 'version.id', 'skill.defaultVersionId')
          .select('skill.skillKey as skillId')
          .where({ 'grant.effect': 'allow', 'skill.status': 'active', 'version.status': 'active' })
          .whereIn('grant.teamId', groupIds)
        : Promise.resolve([]),
      this.db('user_skill_grants as grant')
        .join('skills as skill', 'skill.id', 'grant.skillId')
        .join('skill_versions as version', 'version.id', 'skill.defaultVersionId')
        .select('skill.skillKey as skillId')
        .where({
          'grant.userId': userId,
          'grant.effect': 'allow',
          'skill.status': 'active',
          'version.status': 'active',
        }),
      groupIds.length
        ? this.db('mcp_server_group_grants')
          .select('serverId')
          .whereIn('groupId', groupIds)
        : Promise.resolve([]),
      groupIds.length
        ? this.db('knowledge_source_group_grants')
          .select('knowledgeSourceId')
          .whereIn('groupId', groupIds)
        : Promise.resolve([]),
    ]);

    return {
      isAdmin: user.isAdmin,
      skillIds: normalizeUniqueStrings(
        [
          ...legacyGroupSkills,
          ...legacyDirectSkills,
          ...governedTeamSkills,
          ...governedDirectSkills,
        ].map((row: any) => String(row.skillId || '')),
      ),
      mcpServerIds: normalizeUniqueStrings((mcpRows as Array<{ serverId?: string }>).map((row) => String(row.serverId || ''))),
      knowledgeSourceIds: normalizeUniqueNumbers(
        (knowledgeRows as Array<{ knowledgeSourceId?: number }>).map((row) => Number(row.knowledgeSourceId)),
      ),
    };
  }

  async getWorkspaceSkillRuntimePins(workspaceId: string): Promise<WorkspaceSkillRuntimePin[]> {
    const rows = await this.db('workspace_skill_pins as pin')
      .join('skills as skill', 'skill.id', 'pin.skillId')
      .join('skill_versions as version', 'version.id', 'pin.skillVersionId')
      .select(
        'skill.id as skillId',
        'skill.skillKey',
        'version.id as versionId',
        'version.semanticVersion',
        'version.manifestHash',
        'pin.semanticVersion as pinnedSemanticVersion',
        'pin.manifestHash as pinnedManifestHash',
        'pin.validationStatus',
        'skill.status as skillStatus',
        'version.status as versionStatus',
      )
      .where({ 'pin.workspaceId': workspaceId })
      .orderBy('skill.skillKey', 'asc');
    return rows.map((row: any) => ({
      skillId: row.skillId,
      skillKey: row.skillKey,
      versionId: row.versionId,
      semanticVersion: row.semanticVersion,
      manifestHash: row.manifestHash,
      available: row.validationStatus === 'valid'
        && row.skillStatus === 'active'
        && row.versionStatus === 'active'
        && row.pinnedSemanticVersion === row.semanticVersion
        && row.pinnedManifestHash === row.manifestHash,
    }));
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
      if (user.isAdmin) {
        const admins = await tx<UserRecord>('users').where({ isAdmin: true }).forUpdate();
        if (admins.length <= 1) {
          throw new ConflictError('The final active Platform Admin cannot be deleted');
        }
      }
      const governedReview = await tx('skill_review_requests')
        .where({ proposerUserId: userId })
        .first();
      if (governedReview) {
        throw new ConflictError('A user with governed skill review history cannot be deleted');
      }
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
