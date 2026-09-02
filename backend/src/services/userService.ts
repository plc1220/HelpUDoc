import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { ConflictError, NotFoundError } from '../errors';
import { isPlatformAdmin } from './governance/teamRoles';
import {
  applyWorkspaceOwnershipTransfer,
  isSharedWorkspaceRecord,
  workspacePurgeDeadline,
  type WorkspaceRecord,
} from './workspaceService';

export type UserStatus = 'active' | 'deactivated';

export interface UserRecord {
  id: string;
  externalId: string;
  email?: string | null;
  displayName: string;
  isAdmin: boolean;
  /**
   * Optional on the type although the column is NOT NULL: rows written before
   * the column existed, and the hand-built database fakes in the test suite,
   * both omit it. Read it through `isUserDeactivated` so "absent" is never
   * mistaken for "suspended".
   */
  status?: UserStatus;
  deactivatedAt?: string | null;
  deactivatedByUserId?: string | null;
  deactivationReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Absent status means active — see the note on `UserRecord.status`. */
export const isUserDeactivated = (
  user: Pick<UserRecord, 'status'> | null | undefined,
): boolean => user?.status === 'deactivated';

export interface GroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupPromptAccess {
  skillIds: string[];
  mcpServerIds: string[];
  knowledgeBaseIds: string[];
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

export interface OwnedWorkspaceSummary {
  id: string;
  name: string;
  visibility: 'private' | 'team';
  isShared: boolean;
  status: string;
  isSystem: boolean;
}

/** A user who could take over a Shared workspace whose owner is being suspended. */
export interface OwnershipCandidate {
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
}

export interface SharedWorkspaceHandover {
  id: string;
  name: string;
  status: string;
  candidates: OwnershipCandidate[];
}

export interface UserDeactivationImpact {
  user: Pick<UserRecord, 'id' | 'displayName' | 'email' | 'externalId' | 'isAdmin' | 'status'>;
  /** Private workspaces that will be archived, and when they would be retired. */
  archivedWorkspaces: OwnedWorkspaceSummary[];
  purgeAfter: string;
  /** Shared workspaces that need a new owner before deactivation can proceed. */
  sharedWorkspaces: SharedWorkspaceHandover[];
  activeScheduleCount: number;
}

export interface UserDeletionImpact {
  user: Pick<UserRecord, 'id' | 'displayName' | 'email' | 'externalId' | 'isAdmin' | 'status'>;
  ownedWorkspaces: OwnedWorkspaceSummary[];
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

export type UserSortField = 'displayName' | 'email' | 'role' | 'createdAt';
export type UserSortOrder = 'asc' | 'desc';

export interface UserPage {
  users: UserRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Short-lived cache for the per-request deactivation check.
 *
 * Module-scoped rather than an instance field on purpose: the test suite builds
 * services with `Object.create(UserService.prototype)`, which skips field
 * initializers and would leave a class-field Map undefined on first use.
 */
const USER_STATUS_CACHE_TTL_MS = 30_000;
const userStatusCache = new Map<string, { deactivated: boolean; expiresAt: number }>();

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

    // A deactivated identity is not re-promoted by ADMIN_EMAILS. Deactivation is
    // the stronger statement, and letting an env var quietly re-admin a suspended
    // account would undo it on their next request.
    if (!existing.isAdmin && email && adminEmails.has(email) && !isUserDeactivated(existing)) {
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
      .where('isSystem', false)
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

    const countRow = await applySearch(this.db('users').where('isSystem', false))
      .count<{ count: string }>('id as count')
      .first();
    const total = Number(countRow?.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const sortColumn = sortColumns[options.sortBy];

    const users = await applySearch(this.db<UserRecord>('users').select('*').where('isSystem', false))
      .orderBy(sortColumn, options.sortOrder, options.sortBy === 'email' ? 'last' : undefined)
      .orderBy('id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { users, total, page, pageSize, totalPages };
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.db<UserRecord>('users')
      .where({ id: userId })
      .andWhere('isSystem', false)
      .first();
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
      .andWhere('isSystem', false)
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
      if ((target as UserRecord & { isSystem?: boolean }).isSystem) {
        throw new ConflictError('System identities cannot be modified');
      }
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
      await this.detachTeamOnlyWorkspaceLinks(tx, groupId);
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
      await this.detachTeamOnlyWorkspaceLinks(tx, groupId, userId);
      await tx('team_role_bindings').where({ teamId: groupId, userId }).del();
      const deleted = await tx('group_members').where({ groupId, userId }).del();
      return Number(deleted || 0);
    });
  }

  private async detachTeamOnlyWorkspaceLinks(
    tx: Knex.Transaction,
    groupId: string,
    userId?: string,
  ): Promise<void> {
    let query = tx('workspace_publication_links as link')
      .join('workspaces as workspace', 'workspace.id', 'link.teamWorkspaceId')
      .leftJoin('workspace_members as direct', function joinDirectWorkspaceAccess() {
        this.on('direct.workspaceId', '=', 'link.teamWorkspaceId')
          .andOn('direct.userId', '=', 'link.userId');
      })
      .where('workspace.teamId', groupId)
      .whereNull('direct.userId')
      .select('link.privateWorkspaceId');
    if (userId) query = query.andWhere('link.userId', userId);
    const links = await query as Array<{ privateWorkspaceId: string }>;
    const privateWorkspaceIds = links.map((link) => String(link.privateWorkspaceId));
    if (!privateWorkspaceIds.length) return;
    await tx('workspace_publication_links')
      .whereIn('privateWorkspaceId', privateWorkspaceIds)
      .update({
        status: 'detached',
        detachedAt: tx.fn.now(),
        reconnectToken: null,
        updatedAt: tx.fn.now(),
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
      this.db('knowledge_base_group_grants')
        .select('knowledgeBaseId')
        .where({ teamId: groupId, effect: 'allow' }),
    ]);

    return {
      skillIds: normalizeUniqueStrings(
        [...legacySkillRows, ...governedSkillRows]
          .map((row: any) => String(row.skillId || '')),
      ),
      mcpServerIds: normalizeUniqueStrings((mcpRows as Array<{ serverId?: string }>).map((row) => String(row.serverId || ''))),
      knowledgeBaseIds: normalizeUniqueStrings(
        (knowledgeRows as Array<{ knowledgeBaseId?: string }>).map((row) => String(row.knowledgeBaseId || '')),
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
    const knowledgeBaseIds = normalizeUniqueStrings(access.knowledgeBaseIds || []);

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

      await tx('knowledge_base_group_grants').where({ teamId: groupId }).del();
      if (knowledgeBaseIds.length) {
        await tx('knowledge_base_group_grants').insert(
          knowledgeBaseIds.map((knowledgeBaseId) => ({
            knowledgeBaseId,
            teamId: groupId,
            effect: 'allow',
            grantedByUserId: actorUserId || null,
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
            knowledgeBaseIds,
          }),
        });
      }
      return {
        skillIds,
        mcpServerIds,
        knowledgeBaseIds,
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
        ? this.db('knowledge_base_group_grants')
          .select('knowledgeBaseId')
          .whereIn('teamId', groupIds)
          .andWhere('effect', 'allow')
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
      knowledgeBaseIds: normalizeUniqueStrings(
        (knowledgeRows as Array<{ knowledgeBaseId?: string }>).map((row) => String(row.knowledgeBaseId || '')),
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

  /**
   * Workspaces this user owns. `purged` rows are excluded by default: they are
   * retained only so an operator can restore them, and counting them as live
   * would both inflate the impact preview and block a legitimate user deletion.
   */
  async listOwnedWorkspaces(
    userId: string,
    options: { includePurged?: boolean } = {},
  ): Promise<OwnedWorkspaceSummary[]> {
    const query = this.db('workspaces')
      .select('id', 'name', 'visibility', 'workspaceType', 'status', 'isSystem')
      .where({ ownerId: userId });
    if (!options.includePurged) {
      query.whereNot({ status: 'purged' });
    }
    const rows = await query.orderBy('name', 'asc');
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      visibility: row.visibility === 'team' ? 'team' : 'private',
      isShared: row.workspaceType === 'team' || row.visibility === 'team',
      status: String(row.status || 'active'),
      isSystem: Boolean(row.isSystem),
    }));
  }

  /**
   * Is this user a platform admin? `users.isAdmin` OR a `platform_role_bindings`
   * row, matching what the governance services already enforce. Two definitions
   * of "admin" that can disagree is not a distinction worth keeping.
   */
  /**
   * Is this user currently suspended? Answered from a short-lived cache because
   * it runs on every authenticated request, and invalidated the moment a status
   * changes so a deactivation takes effect immediately rather than whenever the
   * cache happens to expire.
   *
   * This exists because `userContextMiddleware` serves an authenticated request
   * from `req.session.userContext` without ever re-reading the database — so
   * without a check here, a user who is deactivated mid-session keeps full
   * access until their session expires.
   */
  async isDeactivated(userId: string): Promise<boolean> {
    const cached = userStatusCache.get(userId);
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      return cached.deactivated;
    }
    const row = await this.db('users').select('status').where({ id: userId }).first();
    // An unknown user is not "deactivated" — that is a 401 for the caller to
    // raise, and reporting it as a suspension would produce the wrong message.
    const deactivated = row ? row.status === 'deactivated' : false;
    userStatusCache.set(userId, { deactivated, expiresAt: now + USER_STATUS_CACHE_TTL_MS });
    return deactivated;
  }

  private invalidateUserStatus(userId: string): void {
    userStatusCache.delete(userId);
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    return isPlatformAdmin(this.db, userId);
  }

  /**
   * What deactivating this user would do, so an admin decides with the
   * consequences in front of them rather than after the fact.
   *
   * Shared workspaces come back with candidate owners attached: deactivation
   * refuses to proceed until each one has been handed to somebody, because
   * leaving a team workspace owned by a suspended account blocks every
   * owner-gated action on it for everyone else.
   */
  async getUserDeactivationImpact(userId: string): Promise<UserDeactivationImpact | null> {
    const user = await this.getUserById(userId);
    if (!user) return null;

    const owned = await this.listOwnedWorkspaces(userId);
    const live = owned.filter((workspace) => !workspace.isSystem && workspace.status !== 'trashed');
    const sharedWorkspaces = live.filter((workspace) => workspace.isShared);

    const candidatesByWorkspace = await this.listOwnershipCandidates(
      sharedWorkspaces.map((workspace) => workspace.id),
      userId,
    );

    const activeScheduleRow = await this.db('workspace_schedules')
      .where({ createdBy: userId, status: 'active' })
      .count<{ count: string }>('id as count')
      .first();

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        externalId: user.externalId,
        isAdmin: user.isAdmin,
        status: user.status || 'active',
      },
      archivedWorkspaces: live.filter((workspace) => !workspace.isShared),
      purgeAfter: workspacePurgeDeadline().toISOString(),
      sharedWorkspaces: sharedWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        candidates: candidatesByWorkspace.get(workspace.id) || [],
      })),
      activeScheduleCount: Number(activeScheduleRow?.count || 0),
    };
  }

  private async listOwnershipCandidates(
    workspaceIds: string[],
    excludeUserId: string,
  ): Promise<Map<string, OwnershipCandidate[]>> {
    const byWorkspace = new Map<string, OwnershipCandidate[]>();
    if (!workspaceIds.length) return byWorkspace;

    const rows = await this.db('workspace_members as member')
      .join('users as u', 'u.id', 'member.userId')
      .whereIn('member.workspaceId', workspaceIds)
      .andWhere('member.userId', '<>', excludeUserId)
      .andWhere('u.isSystem', false)
      .andWhereNot('u.status', 'deactivated')
      .select('member.workspaceId', 'member.role', 'u.id', 'u.displayName', 'u.email');

    for (const row of rows as Array<Record<string, unknown>>) {
      const workspaceId = String(row.workspaceId);
      const list = byWorkspace.get(workspaceId) || [];
      list.push({
        userId: String(row.id),
        displayName: String(row.displayName),
        email: (row.email as string | null) ?? null,
        role: String(row.role),
      });
      byWorkspace.set(workspaceId, list);
    }
    return byWorkspace;
  }

  /**
   * Suspends a user's access without destroying anything.
   *
   * Private workspaces they own are archived into the existing 30-day trash so
   * one retention mechanism covers both owner-initiated deletes and this, and
   * are stamped `owner_deactivated` so reactivation restores exactly these and
   * leaves anything the owner threw away themselves alone. Shared workspaces are
   * handed to a nominated owner immediately — collaborators should never be
   * blocked waiting out somebody else's suspension. Their schedules are paused,
   * because automation that keeps running as a suspended user is the whole thing
   * this feature exists to stop.
   *
   * All of it in one transaction: a half-applied deactivation would leave a user
   * locked out of workspaces nobody else can administer.
   */
  async deactivateUser(
    userId: string,
    actorUserId: string,
    options: { reason?: string | null; sharedWorkspaceOwners?: Array<{ workspaceId: string; newOwnerUserId: string }> } = {},
  ): Promise<{ archivedWorkspaceIds: string[]; transferredWorkspaceIds: string[]; pausedScheduleCount: number }> {
    if (userId === actorUserId) {
      throw new ConflictError('You cannot deactivate your own account');
    }
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    if (isUserDeactivated(user)) {
      return { archivedWorkspaceIds: [], transferredWorkspaceIds: [], pausedScheduleCount: 0 };
    }

    // Empty strings arrive from HTTP where the type says "optional". `??` would
    // let '' through and store a blank reason as if one had been given.
    const reason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : null;
    const assignments = new Map(
      (options.sharedWorkspaceOwners || [])
        .filter((entry) => entry && typeof entry.workspaceId === 'string' && typeof entry.newOwnerUserId === 'string')
        .map((entry) => [entry.workspaceId.trim(), entry.newOwnerUserId.trim()] as const)
        .filter(([workspaceId, newOwnerUserId]) => workspaceId && newOwnerUserId),
    );

    return this.db.transaction(async (tx) => {
      const target = await tx<UserRecord>('users').where({ id: userId }).forUpdate().first();
      if (!target) throw new NotFoundError('User not found');
      if ((target as UserRecord & { isSystem?: boolean }).isSystem) {
        throw new ConflictError('System identities cannot be deactivated');
      }
      if (isUserDeactivated(target)) {
        return { archivedWorkspaceIds: [], transferredWorkspaceIds: [], pausedScheduleCount: 0 };
      }
      if (target.isAdmin) {
        const remainingAdmins = await tx<UserRecord>('users')
          .where({ isAdmin: true })
          .andWhere('isSystem', false)
          .andWhere((builder) => builder.whereNull('status').orWhereNot({ status: 'deactivated' }))
          .forUpdate();
        if (remainingAdmins.length <= 1) {
          throw new ConflictError('The final active Platform Admin cannot be deactivated');
        }
      }

      const owned = await tx('workspaces')
        .where({ ownerId: userId })
        .andWhere({ isSystem: false })
        .whereNotIn('status', ['trashed', 'purged'])
        .forUpdate() as WorkspaceRecord[];

      const shared = owned.filter((workspace) => isSharedWorkspaceRecord(workspace));
      const privateOwned = owned.filter((workspace) => !isSharedWorkspaceRecord(workspace));

      const unassigned = shared.filter((workspace) => !assignments.get(workspace.id));
      if (unassigned.length) {
        throw new ConflictError(
          'Every Shared workspace this user owns needs a new owner before they can be deactivated',
          { workspaceIds: unassigned.map((workspace) => workspace.id) },
        );
      }

      const transferredWorkspaceIds: string[] = [];
      for (const workspace of shared) {
        const newOwnerUserId = assignments.get(workspace.id)!;
        const newOwner = await tx<UserRecord>('users').where({ id: newOwnerUserId }).first();
        if (!newOwner || (newOwner as UserRecord & { isSystem?: boolean }).isSystem) {
          throw new ConflictError(`The nominated owner for "${workspace.name}" does not exist`);
        }
        if (isUserDeactivated(newOwner)) {
          throw new ConflictError(`The nominated owner for "${workspace.name}" is deactivated`);
        }
        await applyWorkspaceOwnershipTransfer(tx, {
          workspace,
          toUserId: newOwnerUserId,
          actorUserId,
          reason,
        });
        transferredWorkspaceIds.push(workspace.id);
      }

      const archivedWorkspaceIds = privateOwned.map((workspace) => workspace.id);
      if (archivedWorkspaceIds.length) {
        await tx('workspaces').whereIn('id', archivedWorkspaceIds).update({
          status: 'trashed',
          trashedAt: tx.fn.now(),
          trashedByUserId: actorUserId,
          trashReason: 'owner_deactivated',
          purgeAfter: workspacePurgeDeadline(),
          updatedAt: tx.fn.now(),
        });
        await tx('audit_events').insert(privateOwned.map((workspace) => ({
          id: uuidv4(),
          actorUserId,
          actorRole: 'platform_admin',
          action: 'workspace.archived_for_deactivation',
          resourceType: 'workspace',
          resourceId: workspace.id,
          platformOverride: true,
          reason,
          metadata: { ownerId: userId, workspaceName: workspace.name },
        })));
      }

      const pausedScheduleCount = await tx('workspace_schedules')
        .where({ createdBy: userId, status: 'active' })
        .update({
          status: 'paused',
          lastError: 'Paused because the schedule owner was deactivated',
          lockedAt: null,
          lockedBy: null,
          updatedAt: tx.fn.now(),
        });

      await tx('users').where({ id: userId }).update({
        status: 'deactivated',
        deactivatedAt: tx.fn.now(),
        deactivatedByUserId: actorUserId,
        deactivationReason: reason,
        updatedAt: tx.fn.now(),
      });

      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId,
        actorRole: 'platform_admin',
        action: 'user.deactivated',
        resourceType: 'user',
        resourceId: userId,
        platformOverride: true,
        reason,
        metadata: {
          archivedWorkspaceIds,
          transferredWorkspaceIds,
          pausedScheduleCount: Number(pausedScheduleCount || 0),
        },
      });

      return {
        archivedWorkspaceIds,
        transferredWorkspaceIds,
        pausedScheduleCount: Number(pausedScheduleCount || 0),
      };
    }).then((result) => {
      // After commit, never before: invalidating early would let a concurrent
      // request re-cache the pre-deactivation status from an uncommitted read.
      this.invalidateUserStatus(userId);
      return result;
    });
  }

  /**
   * Restores a suspended user's access, and with it the private workspaces this
   * deactivation archived — matched on `trashReason`, so a workspace the user
   * had themselves thrown away stays in the trash where they put it.
   *
   * Shared workspaces are not handed back: somebody has been owning and working
   * in them since, and silently demoting them would be its own surprise.
   * Schedules stay paused for the same reason — automation should restart
   * because a person decided to, not as a side effect.
   */
  async reactivateUser(
    userId: string,
    actorUserId: string,
    options: { reason?: string | null } = {},
  ): Promise<{ restoredWorkspaceIds: string[] }> {
    const reason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : null;

    return this.db.transaction(async (tx) => {
      const target = await tx<UserRecord>('users').where({ id: userId }).forUpdate().first();
      if (!target) throw new NotFoundError('User not found');
      if (!isUserDeactivated(target)) {
        return { restoredWorkspaceIds: [] };
      }

      const archived = await tx('workspaces')
        .where({ ownerId: userId, status: 'trashed', trashReason: 'owner_deactivated' })
        .forUpdate() as WorkspaceRecord[];
      const restoredWorkspaceIds = archived.map((workspace) => workspace.id);

      if (restoredWorkspaceIds.length) {
        await tx('workspaces').whereIn('id', restoredWorkspaceIds).update({
          status: 'active',
          trashedAt: null,
          trashedByUserId: null,
          trashReason: null,
          purgeAfter: null,
          updatedAt: tx.fn.now(),
        });
        await tx('audit_events').insert(archived.map((workspace) => ({
          id: uuidv4(),
          actorUserId,
          actorRole: 'platform_admin',
          action: 'workspace.restored_from_deactivation',
          resourceType: 'workspace',
          resourceId: workspace.id,
          platformOverride: true,
          reason,
          metadata: { ownerId: userId, workspaceName: workspace.name },
        })));
      }

      await tx('users').where({ id: userId }).update({
        status: 'active',
        deactivatedAt: null,
        deactivatedByUserId: null,
        deactivationReason: null,
        updatedAt: tx.fn.now(),
      });

      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId,
        actorRole: 'platform_admin',
        action: 'user.reactivated',
        resourceType: 'user',
        resourceId: userId,
        platformOverride: true,
        reason,
        metadata: { restoredWorkspaceIds },
      });

      return { restoredWorkspaceIds };
    }).then((result) => {
      this.invalidateUserStatus(userId);
      return result;
    });
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
        status: user.status || 'active',
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

  /**
   * Permanently removes a user. Deliberately the *second* step: a user must
   * already be deactivated, which is what guarantees their workspaces have been
   * archived or handed over. Deleting straight from active used to cascade
   * `workspaces.ownerId` and silently destroy Shared workspaces other people
   * were working in.
   */
  async deleteUser(userId: string, actorUserId?: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) {
      return false;
    }
    if (!isUserDeactivated(user)) {
      throw new ConflictError('Deactivate this user before deleting them');
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

      // `workspaces.ownerId` is ON DELETE RESTRICT, so a straggler would fail the
      // transaction with a constraint error nobody can act on. Resolve it here
      // instead, with the split that matters:
      //
      //  - A *live* workspace still belongs to somebody's working life. Refuse,
      //    and name it, so an admin hands it over deliberately.
      //  - An archived or retired one is already out of use but must keep a real
      //    owner to stay restorable. It passes to the admin doing the deletion,
      //    who is then the accountable holder of whatever is recovered later.
      //
      // Without the second half, deleting a deactivated user would be impossible
      // until their 30-day archives expired — a dead end the admin portal offers
      // no way out of.
      const stillOwned = await tx('workspaces')
        .where({ ownerId: userId })
        .select('id', 'name', 'status') as Array<{ id: string; name: string; status: string }>;
      const live = stillOwned.filter(
        (workspace) => workspace.status !== 'purged' && workspace.status !== 'trashed',
      );
      if (live.length) {
        throw new ConflictError(
          'This user still owns active workspaces. Transfer ownership or archive them first.',
          { workspaces: live.map((workspace) => ({ id: workspace.id, name: workspace.name })) },
        );
      }
      if (stillOwned.length) {
        if (!actorUserId) {
          throw new ConflictError('An acting administrator is required to inherit retained workspaces');
        }
        const inheritedIds = stillOwned.map((workspace) => workspace.id);
        await tx('workspaces')
          .whereIn('id', inheritedIds)
          .update({ ownerId: actorUserId, lastModifiedBy: actorUserId, updatedAt: tx.fn.now() });
        await tx('workspace_members')
          .insert(inheritedIds.map((workspaceId) => ({
            workspaceId,
            userId: actorUserId,
            role: 'owner',
            canEdit: true,
          })))
          .onConflict(['workspaceId', 'userId'])
          .merge({ role: 'owner', canEdit: true, updatedAt: tx.fn.now() });
        await tx('audit_events').insert(stillOwned.map((workspace) => ({
          id: uuidv4(),
          actorUserId,
          actorRole: 'platform_admin',
          action: 'workspace.inherited_on_user_deletion',
          resourceType: 'workspace',
          resourceId: workspace.id,
          platformOverride: true,
          metadata: {
            previousOwnerUserId: userId,
            newOwnerUserId: actorUserId,
            workspaceName: workspace.name,
            workspaceStatus: workspace.status,
          },
        })));
      }

      await this.detachUserReferences(tx, userId);
      await tx('group_members').where({ userId }).del();
      await tx('workspace_members').where({ userId }).del();
      await tx('user_oauth_tokens').where({ userId }).del();
      await tx('mcp_server_grants').where({ userId }).del();
      await tx('skill_grants').where({ principalType: 'user', principalId: userId }).del();
      await tx('mcp_connection_grants').where({ principalType: 'user', principalId: userId }).del();
      await tx<UserRecord>('users').where({ id: userId }).del();
      // Written last, and inside the transaction, so a deletion that rolls back
      // leaves no record claiming it happened. `audit_events.actorUserId` is
      // SET NULL rather than cascading, so the trail outlives its subject.
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actorUserId || null,
        actorRole: 'platform_admin',
        action: 'user.deleted',
        resourceType: 'user',
        resourceId: userId,
        platformOverride: true,
        metadata: {
          externalId: user.externalId,
          displayName: user.displayName,
          email: user.email || null,
          wasAdmin: user.isAdmin,
        },
      });
    });

    this.invalidateUserStatus(userId);
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
