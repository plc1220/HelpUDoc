// Synthetic process-restart delivery used by calendarReviewFollowUp.test.ts.
// Runs against an isolated test schema and never calls a real calendar provider.
import knex from 'knex';
import { CalendarReviewFollowUpService } from '../../src/services/calendarReviewFollowUpService';
import { WorkspaceService } from '../../src/services/workspaceService';
import { CalendarError } from '../../src/services/calendarModel';
import type { DatabaseService } from '../../src/services/databaseService';

async function main() {
  const schema = process.env.CALENDAR_REVIEW_TEST_SCHEMA;
  if (!schema || !/^calendar_review_[a-f0-9]+$/.test(schema)) throw new Error('An isolated test schema is required');
  const connection = process.env.CALENDAR_REVIEW_DATABASE_URL || process.env.DATABASE_URL || 'postgres://helpudoc:helpudoc@127.0.0.1:5432/helpudoc';
  const db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
  try {
    const workspace = new WorkspaceService({ getDb: () => db } as DatabaseService);
    const event = JSON.parse(process.env.CALENDAR_REVIEW_TEST_EVENT || '{}');
    const service = new CalendarReviewFollowUpService(db, { event: async (_user: string, ref: string) => {
      if (ref !== event.id) throw new Error('Unexpected fixture reference');
      return event;
    } } as any, workspace, { getThread: async (wid: string, tid: string, user: string) => {
      await workspace.ensureMembership(wid, user);
      const row = await db('workspace_team_threads').where({ workspaceId: wid, id: tid }).first();
      if (!row) throw new CalendarError(404, 'NOT_FOUND', 'Thread not found'); return row;
    } } as any, () => new Date(process.env.CALENDAR_REVIEW_TEST_NOW!));
    await service.tick();
  } finally { await db.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
