import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { DatabaseService } from '../src/services/databaseService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { WorkspaceTeamThreadStore } from '../src/services/workspaceTeamThreadStore';
import internalAgentRoutes from '../src/api/internalAgent';
import { signAgentContextToken } from '../src/services/agentToken';
import { HttpError } from '../src/errors';

// Route-level auth tests for the agent-JWT-authenticated internal thread-history
// reader (spec F3.4). Gated with the other integration suites:
//   RUN_THREAD_INTEGRATION=1 DATABASE_URL=... DATABASE_SSL=false npm test
const enabled = process.env.RUN_THREAD_INTEGRATION === '1';

const makeService = (db: any, userId: string, opts: { access?: () => Promise<any> } = {}) => {
  const svc: any = Object.create(WorkspaceCollaborationService.prototype);
  svc.db = db;
  svc.threads = new WorkspaceTeamThreadStore(db);
  svc.ensureSharedWorkspaceAccess = opts.access || (async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true }));
  svc.workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
  return svc as WorkspaceCollaborationService & any;
};

const seedThread = async (db: any, opts: { access?: () => Promise<any> } = {}) => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db('users').insert({ id: userId, externalId: userId, displayName: 'Reader user' });
  await db('workspaces').insert({ id: workspaceId, name: 'Reader ws', slug: workspaceId, ownerId: userId, visibility: 'team' });
  await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
  const svc = makeService(db, userId, opts);
  const a = await svc.createThread(workspaceId, userId, { body: 'root', clientMessageId: randomUUID() });
  const earlier = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'earlier', clientMessageId: randomUUID() });
  const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 's'.repeat(500), clientMessageId: randomUUID() });
  const later = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'after', clientMessageId: randomUUID() });
  return { svc, userId, workspaceId, threadId: a.thread.id, earlier, source, later, cutoffSeq: Number((source as any).sequence) };
};

const withServer = async (svc: any, fn: (base: string) => Promise<void>) => {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent', internalAgentRoutes(svc));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const get = (base: string, threadId: string, workspaceId: string, cutoffSeq: number, token?: string) =>
  fetch(`${base}/api/internal/agent/team-chat/thread-history?workspaceId=${workspaceId}&threadId=${threadId}&fromSeq=0&toSeq=${cutoffSeq}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test('F3 reader: missing/forged/expired bearer is rejected 401', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const seeded = await seedThread(db);
    await withServer(seeded.svc, async (base) => {
      const noAuth = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq);
      assert.equal(noAuth.status, 401, 'missing bearer must be 401');

      const forged = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq, 'not.a.jwt');
      assert.equal(forged.status, 401, 'forged bearer must be 401');

      const expired = signAgentContextToken({
        userId: seeded.userId, workspaceId: seeded.workspaceId, exp: Math.floor(Date.now() / 1000) - 5,
        threadHistoryScope: { workspaceId: seeded.workspaceId, userId: seeded.userId, threadId: seeded.threadId, cutoffSeq: seeded.cutoffSeq, sourceMessageId: seeded.source.id },
      } as any);
      const expiredRes = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq, expired!);
      assert.equal(expiredRes.status, 401, 'expired bearer must be 401');
    });
  } finally { await db.destroy(); }
});

test('F3 reader: cross-scope thread request is refused 403', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const seeded = await seedThread(db);
    await withServer(seeded.svc, async (base) => {
      // Token scoped to THIS thread, but the request targets a different thread id.
      const token = signAgentContextToken({
        userId: seeded.userId, workspaceId: seeded.workspaceId,
        threadHistoryScope: { workspaceId: seeded.workspaceId, userId: seeded.userId, threadId: seeded.threadId, cutoffSeq: seeded.cutoffSeq, sourceMessageId: seeded.source.id },
      });
      const otherThread = randomUUID();
      const res = await fetch(`${base}/api/internal/agent/team-chat/thread-history?workspaceId=${seeded.workspaceId}&threadId=${otherThread}&fromSeq=0&toSeq=${seeded.cutoffSeq}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403, 'cross-thread request must be 403');

      // A token with no thread-history scope is refused 403.
      const noScope = signAgentContextToken({ userId: seeded.userId, workspaceId: seeded.workspaceId });
      const noScopeRes = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq, noScope!);
      assert.equal(noScopeRes.status, 403, 'token without scope must be 403');
    });
  } finally { await db.destroy(); }
});

test('F3 reader: authorized call clamps to cutoff and returns bound source only', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const seeded = await seedThread(db);
    await withServer(seeded.svc, async (base) => {
      const token = signAgentContextToken({
        userId: seeded.userId, workspaceId: seeded.workspaceId,
        threadHistoryScope: { workspaceId: seeded.workspaceId, userId: seeded.userId, threadId: seeded.threadId, cutoffSeq: seeded.cutoffSeq, sourceMessageId: seeded.source.id },
      });
      const res = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq, token!);
      assert.equal(res.status, 200);
      const body = await res.json();
      const ids = body.messages.map((m: any) => m.id);
      assert.ok(ids.includes(seeded.earlier.id), 'earlier message returned');
      assert.ok(ids.includes(seeded.source.id), 'bound source returned at cutoff');
      assert.ok(!ids.includes(seeded.later.id), 'later message denied');
    });
  } finally { await db.destroy(); }
});

test('F3 reader: revoked current access is refused even with a validly signed token', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    // Seed with default (permissive) access, then serve with a service whose
    // CURRENT access recheck throws (simulating revocation at read time).
    const seeded = await seedThread(db);
    const revoked = makeService(db, seeded.userId, {
      access: async () => { throw new HttpError(403, 'Access denied'); },
    });
    await withServer(revoked, async (base) => {
      const token = signAgentContextToken({
        userId: seeded.userId, workspaceId: seeded.workspaceId,
        threadHistoryScope: { workspaceId: seeded.workspaceId, userId: seeded.userId, threadId: seeded.threadId, cutoffSeq: seeded.cutoffSeq, sourceMessageId: seeded.source.id },
      });
      const res = await get(base, seeded.threadId, seeded.workspaceId, seeded.cutoffSeq, token!);
      assert.equal(res.status, 403, 'revoked access must be refused 403');
      const body = await res.json().catch(() => ({}));
      assert.ok(!body.messages || body.messages.length === 0, 'no messages leak on revocation');
    });
  } finally { await db.destroy(); }
});
