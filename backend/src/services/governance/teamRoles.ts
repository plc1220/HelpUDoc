import { Knex } from 'knex';

/**
 * Standalone team/platform role checks shared by the governance services.
 * These mirror the private helpers in `SkillGovernanceService` so knowledge-base
 * governance enforces access identically. Each takes a Knex instance so it can be
 * reused without coupling to a service class.
 */

/** Platform admin = `users.isAdmin` OR a `platform_role_bindings` row with role `platform_admin`. */
export const isPlatformAdmin = async (db: Knex, userId: string): Promise<boolean> => {
  const [user, binding] = await Promise.all([
    db('users').select('isAdmin').where({ id: userId }).first(),
    db('platform_role_bindings').where({ userId, role: 'platform_admin' }).first(),
  ]);
  return Boolean(user?.isAdmin || binding);
};

/** Team lead = a `team_role_bindings` row (role `lead`) backed by active `group_members`. */
export const isTeamLead = async (db: Knex, userId: string, teamId: string): Promise<boolean> => (
  Boolean(await db('team_role_bindings as role')
    .join('group_members as membership', function joinMembership() {
      this.on('membership.groupId', '=', 'role.teamId')
        .andOn('membership.userId', '=', 'role.userId');
    })
    .where({ 'role.teamId': teamId, 'role.userId': userId, 'role.role': 'lead' })
    .first())
);

/** Groups (team ids) the user is a member of. */
export const userTeamIds = async (db: Knex, userId: string): Promise<string[]> => {
  const rows = await db('group_members').select('groupId').where({ userId });
  return rows.map((row: { groupId: string }) => String(row.groupId));
};

/** Team ids the user leads (a `team_role_bindings` role `lead` backed by active membership). */
export const leadTeamIds = async (db: Knex, userId: string): Promise<string[]> => {
  const rows = await db('team_role_bindings as role')
    .join('group_members as membership', function joinMembership() {
      this.on('membership.groupId', '=', 'role.teamId')
        .andOn('membership.userId', '=', 'role.userId');
    })
    .where({ 'role.userId': userId, 'role.role': 'lead' })
    .distinct('role.teamId as teamId');
  return rows.map((row: { teamId: string }) => String(row.teamId));
};

/** Is the user an active member of the team? */
export const isTeamMember = async (db: Knex, userId: string, teamId: string): Promise<boolean> => (
  Boolean(await db('group_members').where({ groupId: teamId, userId }).first())
);
