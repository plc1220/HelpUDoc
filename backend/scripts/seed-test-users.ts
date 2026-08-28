/**
 * Seed test users across a few teams for exercising team-gated features
 * (e.g. Knowledge Base access). Idempotent — safe to re-run.
 *
 * Run (from backend/):
 *   ENV_FILE=../env/local/dev.env ts-node -r tsconfig-paths/register scripts/seed-test-users.ts
 *
 * With AUTH_MODE=headers, sign in as any seeded user by sending the header
 *   x-user-id: <externalId>   (e.g. x-user-id: alice@sales.test)
 */
import { randomUUID } from 'crypto';
import { DatabaseService } from '../src/services/databaseService';

type SeedUser = { externalId: string; displayName: string; lead?: boolean };
type SeedTeam = { name: string; members: SeedUser[] };

const TEAMS: SeedTeam[] = [
  {
    name: 'Sales',
    members: [
      { externalId: 'alice@sales.test', displayName: 'Alice Nguyen', lead: true },
      { externalId: 'bob@sales.test', displayName: 'Bob Tan' },
    ],
  },
  {
    name: 'Legal',
    members: [
      { externalId: 'carol@legal.test', displayName: 'Carol Lim', lead: true },
      { externalId: 'dave@legal.test', displayName: 'Dave Wong' },
    ],
  },
  {
    name: 'Engineering',
    members: [
      { externalId: 'erin@eng.test', displayName: 'Erin Park', lead: true },
      { externalId: 'frank@eng.test', displayName: 'Frank Goh' },
    ],
  },
];

async function main(): Promise<void> {
  const db = new DatabaseService().getDb();
  try {
    for (const team of TEAMS) {
      await db('groups').insert({ id: randomUUID(), name: team.name }).onConflict('name').ignore();
      const group = await db('groups').where({ name: team.name }).first();
      const teamId = String(group.id);

      for (const member of team.members) {
        const externalId = member.externalId.trim().toLowerCase();
        await db('users')
          .insert({
            id: randomUUID(),
            externalId,
            email: externalId,
            displayName: member.displayName,
            isAdmin: false,
          })
          .onConflict('externalId')
          .ignore();
        const user = await db('users').where({ externalId }).first();
        const userId = String(user.id);

        await db('group_members').insert({ groupId: teamId, userId }).onConflict(['groupId', 'userId']).ignore();
        if (member.lead) {
          await db('team_role_bindings')
            .insert({ teamId, userId, role: 'lead' })
            .onConflict(['teamId', 'userId', 'role'])
            .ignore();
        }
        console.log(`  ${team.name.padEnd(12)} ${member.displayName.padEnd(16)} <${externalId}>${member.lead ? '  (team lead)' : ''}`);
      }
    }
    console.log('\nTest users seeded. Sign in via header auth with x-user-id: <externalId>.');
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error('Failed to seed test users:', error);
  process.exit(1);
});
