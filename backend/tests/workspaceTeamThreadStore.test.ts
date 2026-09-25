import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceTeamThreadStore, deriveThreadTitle } from '../src/services/workspaceTeamThreadStore';

/**
 * Minimal in-memory knex-like transaction stub. Supports the query shapes used
 * by WorkspaceTeamThreadStore: insert, where().first(), where().forUpdate().first(),
 * where().update().
 */
const makeTx = () => {
  const tables: Record<string, any[]> = {
    workspace_team_threads: [],
    workspace_team_messages: [],
    workspace_team_thread_user_state: [],
  };
  const now = () => new Date('2026-09-19T00:00:00.000Z').toISOString();
  const tx: any = (table: string) => {
    const rows = tables[table];
    let filter: Record<string, unknown> = {};
    const builder: any = {
      insert(row: any) {
        (Array.isArray(row) ? row : [row]).forEach((r) => rows.push({ ...r }));
        return Promise.resolve();
      },
      where(criteria: any, value?: unknown) {
        if (typeof criteria === 'string') filter = { ...filter, [criteria]: value };
        else filter = { ...filter, ...criteria };
        return builder;
      },
      andWhere(col: string, value: unknown) { filter = { ...filter, [col]: value }; return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
      first() {
        return Promise.resolve(rows.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)));
      },
      update(patch: any) {
        rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
          .forEach((r) => Object.assign(r, patch));
        return Promise.resolve(1);
      },
    };
    return builder;
  };
  tx.fn = { now };
  tx.raw = () => Promise.resolve();
  return { tx, tables };
};

test('deriveThreadTitle uses first nonempty line, truncates to 80 chars with ellipsis, never blank', () => {
  assert.equal(deriveThreadTitle('\n\n  Plan the launch  \nmore'), 'Plan the launch');
  assert.equal(deriveThreadTitle('', 'Explicit title'), 'Explicit title');
  const long = 'x'.repeat(200);
  assert.equal(deriveThreadTitle(long), `${'x'.repeat(80)}…`);
  assert.equal(deriveThreadTitle('   \n   '), 'New thread');
});

test('createThreadWithRoot inserts thread, root at sequence 1, assigns root id, legacy threadRootId null', async () => {
  const { tx, tables } = makeTx();
  const store = new WorkspaceTeamThreadStore({} as any);
  const { thread, message } = await store.createThreadWithRoot(tx, {
    workspaceId: 'ws', authorId: 'alice', body: 'Opening message', originVersionId: null,
    mentionsLumo: false, metadata: {},
  });
  assert.equal(message.sequence, 1);
  assert.equal(thread.rootMessageId, message.id);
  const stored = tables.workspace_team_messages[0];
  assert.equal(stored.sequence, 1);
  assert.equal(stored.threadRootId, null, 'root keeps legacy threadRootId null');
  assert.equal(stored.threadId, thread.id);
  assert.equal(stored.authorType, 'user');
});

test('appendMessage allocates consecutive sequences and dual-writes root id on replies', async () => {
  const { tx, tables } = makeTx();
  const store = new WorkspaceTeamThreadStore({} as any);
  const { thread, message: root } = await store.createThreadWithRoot(tx, {
    workspaceId: 'ws', authorId: 'alice', body: 'Root', originVersionId: null, mentionsLumo: false, metadata: {},
  });
  const second = await store.appendMessage(tx, {
    workspaceId: 'ws', threadId: thread.id, authorId: 'bob', authorType: 'user', body: 'Reply', originVersionId: null,
  });
  const third = await store.appendMessage(tx, {
    workspaceId: 'ws', threadId: thread.id, authorId: null, authorType: 'lumo', body: 'Lumo', originVersionId: null,
  });
  assert.deepEqual([root.sequence, second.sequence, third.sequence], [1, 2, 3]);
  const reply = tables.workspace_team_messages.find((m) => m.id === second.id);
  assert.equal(reply.threadRootId, root.id, 'reply dual-writes legacy root id');
  const threadRow = tables.workspace_team_threads[0];
  assert.equal(Number(threadRow.lastMessageSeq), 3);
});

test('a human message reopens a resolved thread; a lumo/system message does not', async () => {
  const { tx, tables } = makeTx();
  const store = new WorkspaceTeamThreadStore({} as any);
  const { thread } = await store.createThreadWithRoot(tx, {
    workspaceId: 'ws', authorId: 'alice', body: 'Root', originVersionId: null, mentionsLumo: false, metadata: {},
  });
  const threadRow = tables.workspace_team_threads[0];
  threadRow.status = 'resolved';
  threadRow.resolvedBy = 'alice';

  await store.appendMessage(tx, { workspaceId: 'ws', threadId: thread.id, authorId: null, authorType: 'lumo', body: 'still resolved', originVersionId: null });
  assert.equal(threadRow.status, 'resolved', 'lumo message keeps resolved state');

  await store.appendMessage(tx, { workspaceId: 'ws', threadId: thread.id, authorId: 'bob', authorType: 'user', body: 'reopen', originVersionId: null });
  assert.equal(threadRow.status, 'open', 'human message reopens');
  assert.equal(threadRow.resolvedBy, null);
});
