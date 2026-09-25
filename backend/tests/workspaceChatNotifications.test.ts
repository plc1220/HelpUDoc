import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';

test('team messages notify collaborators once, prioritize mentions and skip the sender', async () => {
  const notifications: any[] = [];
  const tables: Record<string, any[]> = {
    workspace_team_threads: [],
    workspace_team_messages: [],
    workspace_team_message_mentions: [],
    workspace_team_thread_user_state: [],
  };
  // Minimal knex-like builder supporting the canonical thread dual-write path.
  const makeBuilder = (table: string) => {
    let filter: Record<string, unknown> = {};
    const rows = tables[table] || (tables[table] = []);
    const builder: any = {
      insert(row: any) {
        if (table === 'notifications') {
          return { onConflict: () => ({ ignore: async () => { notifications.push(row); } }) };
        }
        (Array.isArray(row) ? row : [row]).forEach((r) => rows.push({ ...r }));
        const chain: any = { onConflict: () => ({ merge: async () => undefined, ignore: async () => undefined }) };
        return Object.assign(Promise.resolve(), chain);
      },
      where(criteria: any, value?: unknown) {
        if (typeof criteria === 'string') filter = { ...filter, [criteria]: value };
        else filter = { ...filter, ...criteria };
        return builder;
      },
      andWhere() { return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
      select() { return Promise.resolve(rows); },
      first() { return Promise.resolve(rows.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v))); },
      update: async () => 1,
    };
    return builder;
  };
  const db: any = (table: string) => makeBuilder(table);
  db.fn = { now: () => new Date().toISOString() };
  db.raw = () => undefined;
  db.transaction = async (work: (tx: any) => Promise<void>) => work(db);

  const service: any = new WorkspaceCollaborationService(
    { getDb: () => db } as any,
    { listCollaborators: async () => ({ collaborators: [{ userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }, { userId: 'bob' }] }) } as any,
    {} as any,
  );
  service.ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null });
  service.ensureMentionTargetHasAccess = async () => {};
  service.getTeamMessage = async (_workspaceId: string, id: string) => ({ id });
  const message = await service.createTeamMessage('workspace', 'alice', { body: 'Please review', mentionedUserIds: ['bob', 'bob'] });
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => [n.recipientUserId, n.eventType]), [['bob', 'chat.mentioned'], ['carol', 'chat.message']]);
  for (const n of notifications) {
    assert.equal(n.payload.workspaceId, 'workspace');
    assert.equal(n.payload.messageId, message.id);
    assert.equal(n.payload.channel, 'team');
  }
});
