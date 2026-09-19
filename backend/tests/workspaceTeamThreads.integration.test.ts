import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../src/services/databaseService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { WorkspaceTeamThreadStore } from '../src/services/workspaceTeamThreadStore';

// Real-Postgres integration tests. Gated like the other integration suites so the
// default `npm test` run stays green without a database. Point at the review DB:
//   RUN_THREAD_INTEGRATION=1 DATABASE_URL=postgres://thread_review:thread-review-local@localhost:55439/thread_review DATABASE_SSL=false npm test
const enabled = process.env.RUN_THREAD_INTEGRATION === '1';

const makeService = (db: any, workspaceId: string, userId: string) => {
  const svc: any = Object.create(WorkspaceCollaborationService.prototype);
  svc.db = db;
  svc.threads = new WorkspaceTeamThreadStore(db);
  svc.publicationService = {} as any;
  // Isolate SQL/service behavior; only fixture-owner access is stubbed.
  svc.ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
  svc.ensureMentionTargetHasAccess = async () => {};
  svc.workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
  return svc as WorkspaceCollaborationService & any;
};

const seed = async (db: any) => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db('users').insert({ id: userId, externalId: userId, displayName: 'Thread integration user' });
  await db('workspaces').insert({ id: workspaceId, name: 'Thread integration', slug: workspaceId, ownerId: userId, visibility: 'team' });
  await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
  return { userId, workspaceId };
};

test('A2: payload idempotency — same key + same payload dedupes; changed payload is 409', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    const key = randomUUID();
    const a = await svc.createThread(workspaceId, userId, { body: 'First payload', clientMessageId: key });
    const again = await svc.createThread(workspaceId, userId, { body: 'First payload', clientMessageId: key });
    assert.equal(again.message.id, a.message.id, 'identical retry dedupes to the same message');
    await assert.rejects(
      () => svc.createThread(workspaceId, userId, { body: 'Changed payload', clientMessageId: key }),
      (e: any) => e.details?.code === 'IDEMPOTENCY_KEY_REUSED',
      'changed root payload must be rejected',
    );
    // Reply idempotency
    const replyKey = randomUUID();
    const r = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'Original reply', clientMessageId: replyKey });
    const rAgain = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'Original reply', clientMessageId: replyKey });
    assert.equal(rAgain.id, r.id);
    await assert.rejects(
      () => svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'Different reply', clientMessageId: replyKey }),
      (e: any) => e.details?.code === 'IDEMPOTENCY_KEY_REUSED',
      'changed reply payload must be rejected',
    );
  } finally { await db.destroy(); }
});

test('A2: snapshot pagination is stable — a preexisting thread does not vanish when its activity advances', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    const a = await svc.createThread(workspaceId, userId, { body: 'Thread A', clientMessageId: randomUUID() });
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.createThread(workspaceId, userId, { body: 'Thread B', clientMessageId: randomUUID() });
    const page1 = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1 });
    assert.equal(page1.threads.length, 1);
    const shown = page1.threads[0].id;
    const hidden = [a, b].find((x) => x.thread.id !== shown)!;
    // Advance the hidden thread's live activity above the snapshot cutoff.
    await new Promise((r) => setTimeout(r, 5));
    await svc.postThreadMessage(workspaceId, hidden.thread.id, userId, { body: 'Activity after cutoff', clientMessageId: randomUUID() });
    const page2 = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1, cursor: page1.nextCursor });
    assert.ok(page2.threads.some((t: any) => t.id === hidden.thread.id), 'preexisting thread must still appear on page 2');
  } finally { await db.destroy(); }
});

test('A2 (timezone): microsecond-tied thread activity paginates correctly under a non-UTC DB session timezone', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    // Force a non-UTC session timezone for this connection. Before the fix,
    // to_char() rendered the wall-clock in local time but appended a literal "Z",
    // so the cursor's activityAt was mislabeled UTC and re-casting it shifted the
    // keyset boundary by the offset — the second page repeated the first row.
    await db.raw("SET TIME ZONE 'Asia/Kuala_Lumpur'");
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    for (let n = 0; n < 3; n += 1) {
      await svc.createThread(workspaceId, userId, { body: `Tied ${n}`, clientMessageId: randomUUID() });
    }
    // Collapse all three onto the identical sub-millisecond timestamp so ordering
    // must fall back to the id tiebreaker across pages.
    await db('workspace_team_messages').where({ workspaceId }).update({ createdAt: db.raw('?::timestamptz', ['2020-01-01T00:00:00.123456Z']) });
    const first = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1 });
    assert.equal(first.threads.length, 1);
    // The cursor's activityAt must be the true UTC wall-clock, not the +08:00 local time.
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    assert.equal(cursor.activityAt, '2020-01-01T00:00:00.123456Z', 'cursor activity must be truthful UTC, not local wall-clock mislabeled Z');
    const second = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1, cursor: first.nextCursor });
    assert.equal(second.threads.length, 1, 'microsecond ties must not disappear on the next page');
    assert.notEqual(second.threads[0].id, first.threads[0].id, 'the next page must advance past the cursor row');
    // Full walk covers all three exactly once.
    const seen = new Set<string>([first.threads[0].id, second.threads[0].id]);
    const third = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1, cursor: second.nextCursor });
    if (third.threads.length) seen.add(third.threads[0].id);
    assert.equal(seen.size, 3, 'all three tied threads paginate exactly once');
  } finally { await db.destroy(); }
});

test('A2: cursor is validated against workspace/filter', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    await svc.createThread(workspaceId, userId, { body: 'A', clientMessageId: randomUUID() });
    await svc.createThread(workspaceId, userId, { body: 'B', clientMessageId: randomUUID() });
    const page1 = await svc.listThreads(workspaceId, userId, { status: 'all', limit: 1 });
    await assert.rejects(
      () => svc.listThreads(workspaceId, userId, { status: 'resolved', limit: 1, cursor: page1.nextCursor }),
      /Cursor does not match/,
    );
  } finally { await db.destroy(); }
});

test('A3: only one active Lumo slot per thread; a second @Lumo is rejected 409 THREAD_RUN_ACTIVE and no message is created', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    const first = await svc.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const before = Number((await db('workspace_team_messages').where({ threadId: first.thread.id }).count('* as c'))[0].c);
    await assert.rejects(
      () => svc.postThreadMessage(workspaceId, first.thread.id, userId, { body: '@Lumo do more', clientMessageId: randomUUID() }),
      (e: any) => e.details?.code === 'THREAD_RUN_ACTIVE',
      'second active Lumo must be 409 THREAD_RUN_ACTIVE',
    );
    const after = Number((await db('workspace_team_messages').where({ threadId: first.thread.id }).count('* as c'))[0].c);
    assert.equal(after, before, 'the rejected @Lumo message must not be committed (draft retained)');
    const runs = await db('workspace_team_thread_runs').where({ threadId: first.thread.id });
    assert.equal(runs.length, 1, 'exactly one durable run row for the thread');
  } finally { await db.destroy(); }
});

test('A3: thread context is scoped, guarantees the root, excludes post-cutoff, records omitted ranges', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    // Two interleaved threads.
    const a = await svc.createThread(workspaceId, userId, { body: 'A root', clientMessageId: randomUUID() });
    const b = await svc.createThread(workspaceId, userId, { body: 'B root', clientMessageId: randomUUID() });
    const aIds = new Set<string>([a.message.id]);
    const bIds = new Set<string>([b.message.id]);
    for (let i = 0; i < 30; i += 1) {
      const am = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: `A msg ${i}`, clientMessageId: randomUUID() });
      const bm = await svc.postThreadMessage(workspaceId, b.thread.id, userId, { body: `B msg ${i}`, clientMessageId: randomUUID() });
      aIds.add(am.id); bIds.add(bm.id);
    }
    const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: '@Lumo summarize A', clientMessageId: randomUUID() });
    aIds.add(source.id);
    // A later message after the source must be excluded.
    const later = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'A later message', clientMessageId: randomUUID() });
    aIds.add(later.id);
    const ctx = await svc.buildThreadContext(workspaceId, userId, source.id, { charBudget: 400 });
    assert.equal(ctx.threadId, a.thread.id);
    const includedIds: string[] = ctx.manifest.includedMessageIds;
    // Every included message is a real A message; no B message id is included.
    for (const id of includedIds) {
      assert.ok(aIds.has(id), `included ${id} must be an A message`);
      assert.ok(!bIds.has(id), `no B message may be included`);
    }
    // The post-cutoff message is excluded, and the source itself is not history.
    assert.ok(!includedIds.includes(later.id), 'post-cutoff message excluded');
    assert.ok(!includedIds.includes(source.id), 'source excluded from history');
    // The actual root appears exactly once.
    assert.equal(ctx.manifest.rootMessageId, a.thread.rootMessageId);
    assert.equal(includedIds.filter((id) => id === a.thread.rootMessageId).length, 1, 'root included exactly once');
    assert.equal(ctx.history.filter((m: any) => m.id === a.thread.rootMessageId).length, 1);
    assert.ok((ctx.manifest.omittedRanges as any[]).length > 0, 'omitted ranges recorded under budget');
    assert.equal(ctx.manifest.truncated, true);
  } finally { await db.destroy(); }
});

test('A7 (handoff repair): crash after SQL runId commit before source metadata repairs source and emits ONE reply (real runner)', { skip: !enabled }, async () => {
  const { Readable } = await import('node:stream');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const { WorkspaceTeamChatAgentService } = await import('../src/services/workspaceTeamChatAgentService');
  const { UserService } = await import('../src/services/userService');
  const runService = await import('../src/services/agentRunService');
  const { redisClient } = await import('../src/services/redisService');
  if (!redisClient.isOpen) await redisClient.connect();

  const database = new DatabaseService();
  const db = database.getDb();
  let runId = '';
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const ws = new WorkspaceService(database);
    const files = new FileService(database, ws);
    const pub = new WorkspacePublicationService(database, ws);
    const collab = new WorkspaceCollaborationService(database, ws, pub);
    const userService = new UserService(database);
    const agent: any = new WorkspaceTeamChatAgentService(ws, userService, collab, files, pub, database);

    // Stub ONLY external AI streaming; the REAL startAgentRun registers against
    // real Redis under the stable SQL identity.
    let executions = 0;
    runService.configureAgentRunServices({
      telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null, fileService: null,
      agentStreamClient: {
        runAgentStream: async () => { executions += 1; return { data: Readable.from([
          `${JSON.stringify({ type: 'token', content: 'Done.' })}\n`,
          `${JSON.stringify({ type: 'done', status: 'completed' })}\n`,
        ]) } as any; },
        resumeAgentResponseStream: async () => ({ data: Readable.from([]) } as any),
      },
    });

    (collab as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (collab as any).ensureMentionTargetHasAccess = async () => {};
    (collab as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
    const created = await collab.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const sourceId = created.message.id;
    agent.prepare = async (_w: string, _u: string, source: any) => ({
      workspaceId, userId, persona: 'fast', prompt: 'p', history: [], forceReset: true,
      internetSearchEnabled: false, turnId: `team:${source.id}`, sharedTeamChannel: true, readOnlyWorkspace: true,
    });

    // Crash AFTER the real SQL runId/status commit but BEFORE the source metadata
    // write (process death in the handoff window). Keep the real registration.
    const originalSave = collab.saveThreadRunRunId.bind(collab);
    (collab as any).saveThreadRunRunId = async (...args: any[]) => { await (originalSave as any)(...args); throw new Error('CRASH_AFTER_SQL_RUN_ID_BEFORE_SOURCE_META'); };
    await assert.rejects(() => agent.enqueue(workspaceId, userId, sourceId), /CRASH_AFTER_SQL_RUN_ID/);
    (collab as any).saveThreadRunRunId = originalSave;

    const dispatch = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    runId = dispatch.runId;
    assert.equal(dispatch.dispatchPhase, 'dispatching', 'attempt phase persisted before the runner call');
    // Wait for the real run to complete.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) { const m = await runService.getRunMeta(runId); if (m?.status === 'completed') break; await new Promise((r) => setTimeout(r, 25)); }

    // Recovery: retry enqueue. Must NOT start a second run; must repair source
    // metadata from the durable identity; refresh() emits exactly one reply.
    await agent.enqueue(workspaceId, userId, sourceId);
    const repaired = await db('workspace_team_messages').where({ id: sourceId }).first();
    assert.equal(repaired.metadata.runId, runId, 'retry repairs source metadata from the durable SQL run identity');

    await agent.refresh(workspaceId, userId);
    const replies = await db('workspace_team_messages').where({ threadId: created.thread.id, authorType: 'lumo' });
    assert.equal(replies.length, 1, 'exactly one terminal Lumo reply');
    assert.equal(executions, 1, 'the external agent stream launched exactly once');
    const runRows = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId });
    assert.equal(runRows.length, 1, 'exactly one durable run row');
  } finally {
    runService.configureAgentRunServices({ telemetryService: null, agentStreamClient: null });
    try { if (runId) { await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`); await redisClient.del(`agent:run:${runId}:launch`); } } catch { /* best-effort */ }
    if (redisClient.isOpen) await redisClient.quit();
    await db.destroy();
  }
});

test('A7 (Redis full loss): an attempted run whose runtime state is lost is marked uncertain and NEVER replayed (real runner)', { skip: !enabled }, async () => {
  const { Readable } = await import('node:stream');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const { WorkspaceTeamChatAgentService } = await import('../src/services/workspaceTeamChatAgentService');
  const { UserService } = await import('../src/services/userService');
  const runService = await import('../src/services/agentRunService');
  const { redisClient } = await import('../src/services/redisService');
  if (!redisClient.isOpen) await redisClient.connect();

  const database = new DatabaseService();
  const db = database.getDb();
  let runId = '';
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const ws = new WorkspaceService(database);
    const files = new FileService(database, ws);
    const pub = new WorkspacePublicationService(database, ws);
    const collab = new WorkspaceCollaborationService(database, ws, pub);
    const userService = new UserService(database);
    const agent: any = new WorkspaceTeamChatAgentService(ws, userService, collab, files, pub, database);

    let executions = 0;
    runService.configureAgentRunServices({
      telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null, fileService: null,
      agentStreamClient: {
        runAgentStream: async () => { executions += 1; return { data: Readable.from([
          `${JSON.stringify({ type: 'token', content: 'Done.' })}\n`,
          `${JSON.stringify({ type: 'done', status: 'completed' })}\n`,
        ]) } as any; },
        resumeAgentResponseStream: async () => ({ data: Readable.from([]) } as any),
      },
    });

    (collab as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (collab as any).ensureMentionTargetHasAccess = async () => {};
    (collab as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
    const created = await collab.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const sourceId = created.message.id;
    agent.prepare = async (_w: string, _u: string, source: any) => ({
      workspaceId, userId, persona: 'fast', prompt: 'p', history: [], forceReset: true,
      internetSearchEnabled: false, turnId: `team:${source.id}`, sharedTeamChannel: true, readOnlyWorkspace: true,
    });

    // Attempt the run, crashing in the handoff window (attempt phase committed,
    // runtime run executes) — then wipe ALL runtime state for this run.
    const originalSave = collab.saveThreadRunRunId.bind(collab);
    (collab as any).saveThreadRunRunId = async (...args: any[]) => { await (originalSave as any)(...args); throw new Error('CRASH_AFTER_SQL_RUN_ID_BEFORE_SOURCE_META'); };
    await assert.rejects(() => agent.enqueue(workspaceId, userId, sourceId), /CRASH_AFTER_SQL_RUN_ID/);
    (collab as any).saveThreadRunRunId = originalSave;
    const dispatch = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    runId = dispatch.runId;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) { const m = await runService.getRunMeta(runId); if (m?.status === 'completed') break; await new Promise((r) => setTimeout(r, 25)); }
    await new Promise((r) => setTimeout(r, 150));

    // Redis full loss for this run: delete run/meta/launch and the dedupe key.
    await redisClient.del(`agent:run:${runId}`);
    await redisClient.del(`agent:run:${runId}:meta`);
    await redisClient.del(`agent:run:${runId}:launch`);
    await redisClient.del(`agent:run:key:${workspaceId}:${userId}:fast:team:${sourceId}`);

    // Retry: durable phase is 'dispatching' with no runtime state and non-terminal
    // SQL status → uncertain. Must NOT re-execute; must release the slot.
    await agent.enqueue(workspaceId, userId, sourceId);
    const after = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    const sourceAfter = await db('workspace_team_messages').where({ id: sourceId }).first();
    assert.equal(executions, 1, 'Redis loss after an attempted run must not replay completed work');
    assert.equal(after.runId, runId, 'durable identity is unchanged');
    assert.equal(after.status, 'failed', 'uncertain run releases the active slot');
    assert.equal(after.errorCode, 'RUN_STATE_UNCERTAIN', 'uncertainty is recorded, not silent replay');
    assert.equal(sourceAfter.metadata.runStatus, 'failed', 'source shows an honest failed status');
  } finally {
    runService.configureAgentRunServices({ telemetryService: null, agentStreamClient: null });
    try { if (runId) { await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`); await redisClient.del(`agent:run:${runId}:launch`); } } catch { /* best-effort */ }
    if (redisClient.isOpen) await redisClient.quit();
    await db.destroy();
  }
});

test('A7 (queued-launch recovery): a queued run whose worker never launched is recovered to ONE completion via the team service (real runner)', { skip: !enabled }, async () => {
  const { Readable } = await import('node:stream');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const { WorkspaceTeamChatAgentService } = await import('../src/services/workspaceTeamChatAgentService');
  const { UserService } = await import('../src/services/userService');
  const runService = await import('../src/services/agentRunService');
  const { redisClient } = await import('../src/services/redisService');
  if (!redisClient.isOpen) await redisClient.connect();

  const database = new DatabaseService();
  const db = database.getDb();
  let runId = '';
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const ws = new WorkspaceService(database);
    const files = new FileService(database, ws);
    const pub = new WorkspacePublicationService(database, ws);
    const collab = new WorkspaceCollaborationService(database, ws, pub);
    const userService = new UserService(database);
    const agent: any = new WorkspaceTeamChatAgentService(ws, userService, collab, files, pub, database);

    let executions = 0;
    const streamClient = {
      runAgentStream: async () => { executions += 1; return { data: Readable.from([
        `${JSON.stringify({ type: 'token', content: 'Done.' })}\n`,
        `${JSON.stringify({ type: 'done', status: 'completed' })}\n`,
      ]) } as any; },
      resumeAgentResponseStream: async () => ({ data: Readable.from([]) } as any),
    };
    runService.configureAgentRunServices({ telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null, fileService: null, agentStreamClient: streamClient });

    (collab as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (collab as any).ensureMentionTargetHasAccess = async () => {};
    (collab as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
    const created = await collab.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const sourceId = created.message.id;
    agent.prepare = async (_w: string, _u: string, source: any) => ({
      workspaceId, userId, persona: 'fast', prompt: 'p', history: [], forceReset: true,
      internetSearchEnabled: false, turnId: `team:${source.id}`, sharedTeamChannel: true, readOnlyWorkspace: true,
    });

    // Telemetry throws inside the REAL startAgentRun, AFTER queued metadata is
    // registered but BEFORE the worker launches. The queued runtime run exists but
    // its worker never started.
    runService.configureAgentRunServices({ telemetryService: { recordQueuedRun: async () => { throw new Error('TEAM_CRASH_BEFORE_LAUNCH'); } } as any });
    await assert.rejects(() => agent.enqueue(workspaceId, userId, sourceId), /TEAM_CRASH_BEFORE_LAUNCH/);
    runService.configureAgentRunServices({ telemetryService: null });

    // Retry enqueue: the team service must RECOVER the existing queued run's launch
    // (same id) rather than merely reconciling metadata.
    await agent.enqueue(workspaceId, userId, sourceId);
    const dispatch = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    runId = dispatch.runId;
    const deadline = Date.now() + 3_000;
    let meta = await runService.getRunMeta(runId);
    while (meta?.status !== 'completed' && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); meta = await runService.getRunMeta(runId); }
    assert.equal(meta?.status, 'completed', 'the recovered queued run reaches one completion');
    assert.equal(executions, 1, 'exactly one execution after launch recovery');

    await agent.refresh(workspaceId, userId);
    const replies = await db('workspace_team_messages').where({ threadId: created.thread.id, authorType: 'lumo' });
    assert.equal(replies.length, 1, 'exactly one terminal Lumo reply');
    const runRows = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId });
    assert.equal(runRows.length, 1, 'exactly one durable run row');
  } finally {
    runService.configureAgentRunServices({ telemetryService: null, agentStreamClient: null });
    try { if (runId) { await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`); await redisClient.del(`agent:run:${runId}:launch`); } } catch { /* best-effort */ }
    if (redisClient.isOpen) await redisClient.quit();
    await db.destroy();
  }
});

test('A7 (live concurrent retry): a concurrent retry does not mistake a live first dispatch for uncertain work (real runner)', { skip: !enabled }, async () => {
  const { Readable } = await import('node:stream');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const { WorkspaceTeamChatAgentService } = await import('../src/services/workspaceTeamChatAgentService');
  const { UserService } = await import('../src/services/userService');
  const runService = await import('../src/services/agentRunService');
  const { redisClient } = await import('../src/services/redisService');
  if (!redisClient.isOpen) await redisClient.connect();

  const database = new DatabaseService();
  const db = database.getDb();
  let runId = '';
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const ws = new WorkspaceService(database);
    const files = new FileService(database, ws);
    const pub = new WorkspacePublicationService(database, ws);
    const collab = new WorkspaceCollaborationService(database, ws, pub);
    const userService = new UserService(database);
    const agent: any = new WorkspaceTeamChatAgentService(ws, userService, collab, files, pub, database);

    let executions = 0;
    runService.configureAgentRunServices({ telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null, fileService: null, agentStreamClient: {
      runAgentStream: async () => { executions += 1; return { data: Readable.from([
        `${JSON.stringify({ type: 'token', content: 'Done.' })}\n`,
        `${JSON.stringify({ type: 'done', status: 'completed' })}\n`,
      ]) } as any; },
      resumeAgentResponseStream: async () => ({ data: Readable.from([]) } as any),
    } });

    (collab as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (collab as any).ensureMentionTargetHasAccess = async () => {};
    (collab as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
    const created = await collab.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const sourceId = created.message.id;
    agent.prepare = async (_w: string, _u: string, source: any) => ({
      workspaceId, userId, persona: 'fast', prompt: 'p', history: [], forceReset: true,
      internetSearchEnabled: false, turnId: `team:${source.id}`, sharedTeamChannel: true, readOnlyWorkspace: true,
    });

    // Pause the FIRST enqueue after its dispatch-phase transaction commits but
    // before runner registration, then start a concurrent retry. The per-source
    // advisory ownership must serialize the whole handoff so the retry blocks and
    // re-reads live state — never classifying the live first dispatch as uncertain.
    const originalLock = collab.withTeamMessageLock.bind(collab);
    let signalPhase: () => void; let releasePhase: () => void;
    const phaseReached = new Promise<void>((r) => { signalPhase = r; });
    const phaseGate = new Promise<void>((r) => { releasePhase = r; });
    let paused = false;
    (collab as any).withTeamMessageLock = async (...args: any[]) => {
      const result = await (originalLock as any)(...args);
      if (!paused && result === false) { paused = true; signalPhase(); await phaseGate; }
      return result;
    };
    const first = agent.enqueue(workspaceId, userId, sourceId);
    await phaseReached;
    const second = agent.enqueue(workspaceId, userId, sourceId);
    await new Promise((r) => setTimeout(r, 100));
    releasePhase!();
    await Promise.all([first, second]);
    (collab as any).withTeamMessageLock = originalLock;

    const dispatch = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    runId = dispatch.runId;
    const deadline = Date.now() + 3_000;
    let meta = await runService.getRunMeta(runId);
    while (meta?.status !== 'completed' && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); meta = await runService.getRunMeta(runId); }
    assert.equal(executions, 1, 'a concurrent retry must not classify a live first dispatch as uncertain');
    assert.notEqual(dispatch.status, 'failed', 'a live dispatch is not marked uncertain');
    assert.equal(meta?.status, 'completed', 'the single run completes once');
  } finally {
    runService.configureAgentRunServices({ telemetryService: null, agentStreamClient: null });
    try { if (runId) { await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`); await redisClient.del(`agent:run:${runId}:launch`); } } catch { /* best-effort */ }
    if (redisClient.isOpen) await redisClient.quit();
    await db.destroy();
  }
});

test('A9: deep-link message resolution requires access (outsider rejected)', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    const created = await svc.createThread(workspaceId, userId, { body: 'Private thread', clientMessageId: randomUUID() });
    // Outsider service: access check throws.
    const outsider: any = Object.create(WorkspaceCollaborationService.prototype);
    outsider.db = db;
    outsider.threads = new WorkspaceTeamThreadStore(db);
    outsider.ensureSharedWorkspaceAccess = async () => { const e: any = new Error('denied'); e.statusCode = 403; throw e; };
    await assert.rejects(() => outsider.resolveThreadForMessage(workspaceId, created.message.id, randomUUID()), /denied/);
    // The outsider attempt must not have written any lazy migration.
    const runs = await db('workspace_team_threads').where({ id: created.thread.id });
    assert.equal(runs.length, 1);
  } finally { await db.destroy(); }
});

test('A12: backfill is idempotent on mixed legacy + new-format data and preserves canonical roots', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);
    // New-format thread (thread id != root message id) via the service.
    const modern = await svc.createThread(workspaceId, userId, { body: 'Modern root', clientMessageId: randomUUID() });
    await svc.postThreadMessage(workspaceId, modern.thread.id, userId, { body: 'Modern reply', clientMessageId: randomUUID() });
    // Legacy-format rows: no threadId/sequence, replies via threadRootId.
    const legacyRoot = randomUUID();
    await db('workspace_team_messages').insert({ id: legacyRoot, workspaceId, authorId: userId, authorType: 'user', body: 'Legacy root', threadRootId: null, mentionsLumo: false, metadata: {} });
    const legacyReply = randomUUID();
    await db('workspace_team_messages').insert({ id: legacyReply, workspaceId, authorId: userId, authorType: 'user', body: 'Legacy reply', threadRootId: legacyRoot, mentionsLumo: false, metadata: {} });

    const store = new WorkspaceTeamThreadStore(db);
    const runBackfill = async () => {
      const roots = await db('workspace_team_messages').whereNull('threadRootId').whereNull('threadId').select('id', 'workspaceId');
      for (const root of roots) {
        await db.transaction((tx) => store.migrateLegacyGroup(tx, String(root.workspaceId), String(root.id)));
      }
    };
    await runBackfill();
    await runBackfill(); // second run must not throw or duplicate

    // Verify invariants (scoped to THIS workspace — the shared review DB may
    // retain deliberately-quarantined foreign rows from the quarantine test).
    const unmigrated = Number((await db('workspace_team_messages').where({ workspaceId }).whereNull('threadId').count('* as c'))[0].c);
    assert.equal(unmigrated, 0, 'every message in this workspace has a canonical thread');
    const dup = await db.raw(`SELECT "threadId","sequence",COUNT(*) FROM workspace_team_messages WHERE "threadId" IS NOT NULL GROUP BY "threadId","sequence" HAVING COUNT(*)>1`);
    assert.equal(dup.rows.length, 0, 'no duplicate (threadId, sequence)');
    const legacyThread = await db('workspace_team_threads').where({ id: legacyRoot }).first();
    assert.ok(legacyThread, 'legacy root became a thread keyed by its id');
    const legacyReplyRow = await db('workspace_team_messages').where({ id: legacyReply }).first();
    assert.equal(legacyReplyRow.threadId, legacyRoot);
    assert.equal(Number(legacyReplyRow.sequence), 2, 'legacy reply resolves to seq 2');
    // Modern thread untouched (root id != thread id and still one thread).
    const modernThreads = await db('workspace_team_threads').where({ id: modern.thread.id });
    assert.equal(modernThreads.length, 1);
  } finally { await db.destroy(); }
});

test('A12 (quarantine/cycles): foreign-root replies stay quarantined; same-workspace cycles recover; restart is idempotent', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { runBackfill, verify } = await import('../scripts/backfill-team-threads');
    const store = new WorkspaceTeamThreadStore(db);
    const userId = randomUUID();
    const wa = randomUUID();
    const wb = randomUUID();
    await db('users').insert({ id: userId, externalId: userId, displayName: 'Migration regression' });
    await db('workspaces').insert([wa, wb].map((id) => ({ id, name: 'Migration regression', slug: id, ownerId: userId, visibility: 'team' })));
    await db('workspace_members').insert([wa, wb].map((workspaceId) => ({ workspaceId, userId, role: 'owner' }))).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);

    const foreignRoot = randomUUID();   // a genuine root in workspace A
    const foreignReply = randomUUID();  // a reply in workspace B pointing at A's root
    const cycA = randomUUID();
    const cycB = randomUUID();          // same-workspace A<->B cycle
    const normalRoot = randomUUID();
    const normalReply = randomUUID();   // a normal legacy group in A
    // Explicit historical timestamps so migration ordering is deterministic and
    // reflects TRUE historical order (spec §7.3: sequences follow (createdAt,id),
    // never a forced root-first renumber). The root genuinely precedes its reply.
    const t0 = new Date('2021-03-01T00:00:00.000Z');
    const t1 = new Date('2021-03-01T00:00:01.000Z');
    await db('workspace_team_messages').insert([
      { id: foreignRoot, workspaceId: wa, threadRootId: null, createdAt: t0 },
      { id: foreignReply, workspaceId: wb, threadRootId: foreignRoot, createdAt: t1 },
      { id: cycA, workspaceId: wa, threadRootId: cycB, createdAt: t0 },
      { id: cycB, workspaceId: wa, threadRootId: cycA, createdAt: t1 },
      { id: normalRoot, workspaceId: wa, threadRootId: null, createdAt: t0 },
      { id: normalReply, workspaceId: wa, threadRootId: normalRoot, createdAt: t1 },
    ].map((x) => ({ ...x, authorId: userId, authorType: 'user', body: `Fixture ${x.id}`, mentionsLumo: false, metadata: {} })));

    const first = await runBackfill(db, store, { batch: 50 });
    // Foreign relationship never followed.
    const foreign = await db('workspace_team_messages').where({ id: foreignReply }).first();
    assert.equal(foreign.threadId, null, 'cross-workspace reply stays quarantined (unmigrated)');
    assert.ok(first.quarantined >= 1, 'the cross-workspace reference is reported quarantined');
    // Same-workspace cycle recovered — both messages get a canonical thread.
    const cyc = await db('workspace_team_messages').whereIn('id', [cycA, cycB]);
    assert.ok(cyc.every((m: any) => m.threadId), 'both cycle members recover into canonical threads');
    // IDs/content preserved; normal group migrated with stable sequences by
    // (createdAt,id). The root has the earliest timestamp so it takes sequence 1
    // and the reply sequence 2 — NOT because root is force-ordered first, but
    // because it is genuinely earlier. Crucially the root also stays independently
    // retrievable via thread.rootMessageId regardless of its sequence (spec §7.3).
    const nr = await db('workspace_team_messages').where({ id: normalReply }).first();
    assert.equal(nr.threadId, normalRoot);
    assert.equal(Number(nr.sequence), 2);
    assert.equal(nr.body, `Fixture ${normalReply}`, 'content preserved');
    const nThread = await db('workspace_team_threads').where({ id: normalRoot }).first();
    assert.equal(nThread.rootMessageId, normalRoot, 'root remains independently retrievable via thread.rootMessageId');
    const nRootMsg = await db('workspace_team_messages').where({ id: normalRoot }).first();
    assert.equal(nRootMsg.threadId, normalRoot, 'root belongs to its own thread');
    assert.equal(Number(nRootMsg.sequence), 1, 'earliest historical message takes sequence 1');

    // Restart is idempotent: a second pass changes nothing and never renumbers.
    const before = await db('workspace_team_messages').whereIn('id', [cycA, cycB, normalRoot, normalReply, foreignRoot]).orderBy('id').select('id', 'threadId', 'sequence');
    await runBackfill(db, store, { batch: 50 });
    const after = await db('workspace_team_messages').whereIn('id', [cycA, cycB, normalRoot, normalReply, foreignRoot]).orderBy('id').select('id', 'threadId', 'sequence');
    assert.deepEqual(after, before, 'a second backfill run is a no-op (stable ids/threads/sequences)');
    const dup = await db.raw(`SELECT "threadId","sequence",COUNT(*) FROM workspace_team_messages WHERE "threadId" IS NOT NULL GROUP BY "threadId","sequence" HAVING COUNT(*)>1`);
    assert.equal(dup.rows.length, 0, 'no duplicate (threadId, sequence)');

    // Same-workspace integrity holds even though a foreign row is deliberately unmigrated.
    const result = await verify(db);
    assert.ok(result.sameWorkspaceOk, `same-workspace integrity must pass: ${result.problems.join('; ')}`);
    // ...but full readiness must remain FALSE while any row is unmapped (spec 7.5).
    assert.equal(result.fullyReady, false, 'full readiness must be blocked while quarantined rows exist');
    assert.ok(result.unmappedCount >= 1, 'the quarantined foreign row is counted as unmapped');
  } finally { await db.destroy(); }
});

test('A12 (lazy parity): a live legacy reply into a cycle recovers with the SAME recovered marker as bulk', { skip: !enabled }, async () => {
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await db('users').insert({ id: userId, externalId: userId, displayName: 'Lazy cycle parity' });
    await db('workspaces').insert({ id: workspaceId, name: 'Lazy cycle parity', slug: workspaceId, ownerId: userId, visibility: 'team', editingPolicy: 'direct' });
    await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
    // Legacy A<->B cycle (neither is a genuine root).
    const a = randomUUID();
    const b = randomUUID();
    await db('workspace_team_messages').insert([{ id: a, threadRootId: b }, { id: b, threadRootId: a }].map((x) => ({ ...x, workspaceId, authorId: userId, authorType: 'user', body: `Cycle ${x.id}`, mentionsLumo: false, metadata: {} })));

    const ws = new WorkspaceService(database);
    const pub = new WorkspacePublicationService(database, ws);
    const svc = new WorkspaceCollaborationService(database, ws, pub);
    (svc as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (svc as any).ensureMentionTargetHasAccess = async () => {};
    (svc as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };

    // Live legacy reply targeting the in-cycle message `a` must lazily migrate it
    // via the SAME unified store logic used by bulk — with the recovered marker.
    const posted = await svc.createTeamMessage(workspaceId, userId, { body: 'Legacy live reply', replyToMessageId: a });
    const original = await db('workspace_team_messages').where({ id: a }).first();
    assert.equal(posted.threadId, original.threadId, 'reply resolves to the recovered thread of its target');
    const thread = await db('workspace_team_threads').where({ id: posted.threadId }).first();
    assert.match(String(thread.title), /recovered/i, 'lazy recovery applies the same [recovered] marker as bulk');
    // Sequence stability: recovered root is seq 1, live reply seq 2, no duplicates.
    const originalSeq = Number(original.sequence);
    const replySeq = Number((await db('workspace_team_messages').where({ id: posted.id }).first()).sequence);
    assert.equal(originalSeq, 1);
    assert.equal(replySeq, 2);
  } finally { await db.destroy(); }
});

test('A12 (shared-root race + indirect chain): concurrent replies to one legacy root serialize; C->A->R maps without renumbering', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await db('users').insert({ id: userId, externalId: userId, displayName: 'Race chain' });
    await db('workspaces').insert({ id: workspaceId, name: 'Race chain', slug: workspaceId, ownerId: userId, visibility: 'team' });
    await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
    const store = new WorkspaceTeamThreadStore(db);
    const [r, a, b, c] = Array.from({ length: 4 }, () => randomUUID());
    // Genuine root R; direct replies A->R, B->R; indirect chain C->A->R.
    await db('workspace_team_messages').insert([
      { id: r, threadRootId: null }, { id: a, threadRootId: r }, { id: b, threadRootId: r }, { id: c, threadRootId: a },
    ].map((x) => ({ ...x, workspaceId, authorId: userId, authorType: 'user', body: `Legacy ${x.id}`, mentionsLumo: false, metadata: {} })));

    // Concurrent migration of two DIFFERENT reply entries (A and B) that both
    // resolve to root R. Pause the first right after its thread lookup returns
    // null, let the second proceed, then release the first. Both must serialize on
    // the resolved ROOT lock and neither may hit a unique violation.
    let signal!: () => void; let release!: () => void;
    const reached = new Promise<void>((x) => { signal = x; });
    const gate = new Promise<void>((x) => { release = x; });
    let paused = false;
    const first = db.transaction(async (tx) => {
      const wrapped = new Proxy(tx, {
        apply(target, thisArg, args: any[]) {
          const q: any = Reflect.apply(target as any, thisArg, args);
          if (args[0] === 'workspace_team_threads') {
            const original = q.first.bind(q);
            q.first = async (...fa: any[]) => {
              const result = await original(...fa);
              if (!result && !paused) { paused = true; signal(); await gate; }
              return result;
            };
          }
          return q;
        },
      });
      return store.migrateLegacyGroup(wrapped as any, workspaceId, a);
    });
    await reached;
    const second = db.transaction((tx) => store.migrateLegacyGroup(tx, workspaceId, b));
    const settled = Promise.allSettled([first, second]);
    await new Promise((x) => setTimeout(x, 150));
    release();
    const results = await settled;
    assert.ok(results.every((x) => x.status === 'fulfilled'), `both must serialize without a unique violation: ${JSON.stringify(results.map((x: any) => x.status === 'fulfilled' ? 'ok' : String(x.reason?.code || x.reason?.message)))}`);

    // Indirect chain C->A->R must be canonicalized even though R is already a thread.
    await db.transaction((tx) => store.migrateLegacyGroup(tx, workspaceId, c));
    const rows = await db('workspace_team_messages').whereIn('id', [r, a, b, c]).orderBy('sequence');
    assert.ok(rows.every((m: any) => m.threadId === r), 'every same-workspace member maps to root R');
    const seqs = rows.map((m: any) => Number(m.sequence)).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2, 3, 4], 'consecutive unique sequences, no gaps or duplicates');
    const dup = await db.raw(`SELECT "sequence",COUNT(*) FROM workspace_team_messages WHERE "threadId"=? GROUP BY "sequence" HAVING COUNT(*)>1`, [r]);
    assert.equal(dup.rows.length, 0, 'no duplicate sequences under the thread');
  } finally { await db.destroy(); }
});

test('A12 (bounded gather): migrating one group does not scale queries with unrelated workspace history (no N+1)', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await db('users').insert({ id: userId, externalId: userId, displayName: 'Bounded gather' });
    await db('workspaces').insert({ id: workspaceId, name: 'Bounded gather', slug: workspaceId, ownerId: userId, visibility: 'team' });
    await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
    const store = new WorkspaceTeamThreadStore(db);

    // Small target group: root R + one reply.
    const r = randomUUID();
    const reply = randomUUID();
    await db('workspace_team_messages').insert([
      { id: r, threadRootId: null }, { id: reply, threadRootId: r },
    ].map((x) => ({ ...x, workspaceId, authorId: userId, authorType: 'user', body: `Target ${x.id}`, mentionsLumo: false, metadata: {} })));

    // A LARGE amount of unrelated legacy history in the SAME workspace (many other
    // roots + replies). The old per-row classify scanned all of these.
    const unrelated: any[] = [];
    for (let i = 0; i < 400; i += 1) {
      const ur = randomUUID();
      unrelated.push({ id: ur, threadRootId: null, workspaceId, authorId: userId, authorType: 'user', body: `Unrelated root ${i}`, mentionsLumo: false, metadata: {} });
      unrelated.push({ id: randomUUID(), threadRootId: ur, workspaceId, authorId: userId, authorType: 'user', body: `Unrelated reply ${i}`, mentionsLumo: false, metadata: {} });
    }
    await db.batchInsert('workspace_team_messages', unrelated, 200);

    // Count queries issued while migrating ONLY the target group.
    let queryCount = 0;
    const listener = () => { queryCount += 1; };
    db.on('query', listener);
    try {
      await db.transaction((tx) => store.migrateLegacyGroup(tx, workspaceId, r));
    } finally {
      db.removeListener('query', listener);
    }

    // A per-row workspace-wide walk over ~800 unrelated rows would issue hundreds
    // of queries. The scoped recursive CTE keeps it to a small constant.
    assert.ok(queryCount < 40, `migration must not scale with unrelated history (issued ${queryCount} queries)`);
    const migrated = await db('workspace_team_messages').whereIn('id', [r, reply]);
    assert.ok(migrated.every((m: any) => m.threadId === r), 'the target group is migrated');
    const seqs = migrated.map((m: any) => Number(m.sequence)).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2]);
    // Unrelated rows are untouched by this targeted migration.
    const untouched = Number((await db('workspace_team_messages').where({ workspaceId }).whereNull('threadId').whereNotIn('id', [r, reply]).count('* as c'))[0].c);
    assert.equal(untouched, unrelated.length, 'unrelated history is left unmigrated by a targeted migration');
  } finally { await db.destroy(); }
});

test('A (readiness): gate + workspace canonical readiness; ready is false while any message is unmapped', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const prevGate = process.env.TEAM_CHAT_THREADS_ENABLED;
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, workspaceId, userId);

    // A fully-canonical thread via the service (threadId + sequence present).
    await svc.createThread(workspaceId, userId, { body: 'Canonical root', clientMessageId: randomUUID() });

    // Gate OFF → enabled false regardless of readiness.
    delete process.env.TEAM_CHAT_THREADS_ENABLED;
    let r = await svc.getTeamChatReadiness(workspaceId, userId);
    assert.equal(r.enabled, false, 'gate off => enabled false');
    assert.equal(r.ready, true, 'all messages canonical => ready true');
    assert.equal(r.unmappedMessageCount, 0);

    // Gate ON.
    process.env.TEAM_CHAT_THREADS_ENABLED = 'true';
    r = await svc.getTeamChatReadiness(workspaceId, userId);
    assert.equal(r.enabled, true, 'gate on => enabled true');
    assert.equal(r.ready, true);

    // Introduce a legacy unmapped message (no threadId/sequence) → not ready.
    await db('workspace_team_messages').insert({ id: randomUUID(), workspaceId, authorId: userId, authorType: 'user', body: 'Legacy unmapped', threadRootId: null, mentionsLumo: false, metadata: {} });
    r = await svc.getTeamChatReadiness(workspaceId, userId);
    assert.equal(r.enabled, true, 'gate still on');
    assert.equal(r.ready, false, 'ready must be false while an unmapped message exists');
    assert.equal(r.unmappedMessageCount, 1);

    // After migrating that message, readiness returns true (enable only after backfill).
    const store = new WorkspaceTeamThreadStore(db);
    const legacy = await db('workspace_team_messages').where({ workspaceId }).whereNull('threadId').first();
    await db.transaction((tx) => store.migrateLegacyGroup(tx, workspaceId, String(legacy.id)));
    r = await svc.getTeamChatReadiness(workspaceId, userId);
    assert.equal(r.ready, true, 'ready after successful backfill of the workspace');
    assert.equal(r.unmappedMessageCount, 0);
  } finally {
    if (prevGate === undefined) delete process.env.TEAM_CHAT_THREADS_ENABLED; else process.env.TEAM_CHAT_THREADS_ENABLED = prevGate;
    await db.destroy();
  }
});

test('A (readiness): requires current workspace access', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const outsider: any = Object.create(WorkspaceCollaborationService.prototype);
    outsider.db = db;
    outsider.threads = new WorkspaceTeamThreadStore(db);
    outsider.ensureSharedWorkspaceAccess = async () => { const e: any = new Error('denied'); e.statusCode = 403; throw e; };
    await assert.rejects(() => outsider.getTeamChatReadiness(workspaceId, randomUUID()), /denied/);
  } finally { await db.destroy(); }
});

test('A7 (production runner): real startAgentRun deduplicates a repeated team dispatch to ONE run and ONE terminal response', { skip: !enabled }, async () => {
  const { Readable } = await import('node:stream');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { WorkspacePublicationService } = await import('../src/services/workspacePublicationService');
  const { WorkspaceTeamChatAgentService } = await import('../src/services/workspaceTeamChatAgentService');
  const { UserService } = await import('../src/services/userService');
  const runService = await import('../src/services/agentRunService');
  const { redisClient } = await import('../src/services/redisService');
  if (!redisClient.isOpen) await redisClient.connect();

  const database = new DatabaseService();
  const db = database.getDb();
  let resolvedRunId = '';
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const ws = new WorkspaceService(database);
    const files = new FileService(database, ws);
    const pub = new WorkspacePublicationService(database, ws);
    const collab = new WorkspaceCollaborationService(database, ws, pub);
    const userService = new UserService(database);
    const agent: any = new WorkspaceTeamChatAgentService(ws, userService, collab, files, pub, database);

    // Stub ONLY the external AI I/O; the real startAgentRun dispatch/dedupe/lease
    // paths execute against real Redis. Count how many distinct runs are launched.
    let runInvocations = 0;
    runService.configureAgentRunServices({
      telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null,
      agentStreamClient: {
        runAgentStream: async () => {
          runInvocations += 1;
          return { data: Readable.from([
            `${JSON.stringify({ type: 'text', text: 'Done.' })}\n`,
            `${JSON.stringify({ type: 'final', reply: 'Done.' })}\n`,
          ]) } as any;
        },
        resumeAgentResponseStream: async () => ({ data: Readable.from([]) } as any),
      },
    });

    // Reserve the slot through the real collaboration path.
    (collab as any).ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
    (collab as any).ensureMentionTargetHasAccess = async () => {};
    (collab as any).workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
    const created = await collab.createThread(workspaceId, userId, { body: '@Lumo do work', clientMessageId: randomUUID() });
    const sourceId = created.message.id;

    // Stub prepare to a deterministic turnId=team:<sourceId> (no MCP/policy deps)
    // but keep the REAL startRun (production startAgentRun) via the seam default.
    agent.prepare = async (_w: string, _u: string, source: any) => ({
      workspaceId, userId, persona: 'fast', prompt: 'p', history: [], forceReset: true,
      internetSearchEnabled: false, turnId: `team:${source.id}`, sharedTeamChannel: true, readOnlyWorkspace: true,
    });

    // First dispatch establishes the stable identity + runtime run.
    await agent.enqueue(workspaceId, userId, sourceId);
    const firstRow = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();
    const firstRunId = firstRow.runId;
    assert.ok(firstRunId, 'stable runner identity persisted at reservation');

    // Simulate a handoff that did not finish writing the source metadata (the
    // durable identity/phase are intact). A retry must RECONCILE to the same run,
    // never start a second one.
    await db('workspace_team_messages').where({ id: sourceId }).update({ metadata: db.raw(`metadata - 'runId'`) });
    await agent.enqueue(workspaceId, userId, sourceId);
    const secondRow = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId }).first();

    assert.equal(secondRow.runId, firstRunId, 'retry reconciles to the same stable runner identity');
    const runRows = await db('workspace_team_thread_runs').where({ sourceMessageId: sourceId });
    assert.equal(runRows.length, 1, 'exactly one durable run row');

    // Wait for the actual run to reach a terminal state rather than asserting the
    // launch count immediately (which races the fire-and-forget worker).
    resolvedRunId = firstRunId;
    const deadline = Date.now() + 5_000;
    let meta = await runService.getRunMeta(firstRunId);
    while ((!meta || !['completed', 'failed', 'cancelled'].includes(meta.status)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      meta = await runService.getRunMeta(firstRunId);
    }
    assert.equal(meta?.status, 'completed', 'the single run reaches one terminal completion');
    assert.equal(runInvocations, 1, 'the external agent stream was launched exactly once');
  } finally {
    runService.configureAgentRunServices({ agentStreamClient: null });
    // Explicit Redis cleanup + close so the integration suite does not hang on an
    // open client handle after the test completes.
    try {
      if (resolvedRunId) {
        await redisClient.del(`agent:run:${resolvedRunId}`);
        await redisClient.del(`agent:run:${resolvedRunId}:meta`);
        await redisClient.del(`agent:run:${resolvedRunId}:launch`);
      }
    } catch { /* best-effort */ }
    if (redisClient.isOpen) await redisClient.quit();
    await db.destroy();
  }
});
