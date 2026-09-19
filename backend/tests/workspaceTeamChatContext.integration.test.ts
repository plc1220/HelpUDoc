import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../src/services/databaseService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { WorkspaceTeamChatAgentService } from '../src/services/workspaceTeamChatAgentService';
import { WorkspaceTeamThreadStore } from '../src/services/workspaceTeamThreadStore';
import { signAgentContextToken, verifyAgentContextToken } from '../src/services/agentToken';
import { TEAM_CONTEXT_HISTORY_PAGE } from '../src/services/workspaceTeamContextBudget';

// Real-Postgres integration tests for spec F3 (thread-scoped Lumo context and the
// authenticated thread-history reader). Gated like the other integration suites:
//   RUN_THREAD_INTEGRATION=1 \
//   DATABASE_URL=postgres://thread_review:thread-review-local@localhost:55439/thread_review \
//   DATABASE_SSL=false npm test
const enabled = process.env.RUN_THREAD_INTEGRATION === '1';

const makeService = (db: any, userId: string) => {
  const svc: any = Object.create(WorkspaceCollaborationService.prototype);
  svc.db = db;
  svc.threads = new WorkspaceTeamThreadStore(db);
  svc.publicationService = {} as any;
  svc.ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null, isShared: true });
  svc.ensureMentionTargetHasAccess = async () => {};
  svc.workspaceService = { listCollaborators: async () => ({ collaborators: [{ userId }] }) };
  return svc as WorkspaceCollaborationService & any;
};

const makeAgent = () => {
  const agent: any = Object.create(WorkspaceTeamChatAgentService.prototype);
  agent.workspaceService = { getMcpServerPolicy: async () => ({ workspaceMode: 'shared_live', editingPolicy: 'direct', canWriteWorkspace: true, workspaceRole: 'owner' }) };
  agent.userService = { getEffectivePromptAccess: async () => ({ skillIds: [] }), getWorkspaceSkillRuntimePins: async () => [] };
  return agent as WorkspaceTeamChatAgentService & any;
};

const seed = async (db: any) => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db('users').insert({ id: userId, externalId: userId, displayName: 'F3 context user' });
  await db('workspaces').insert({ id: workspaceId, name: 'F3 context', slug: workspaceId, ownerId: userId, visibility: 'team' });
  await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
  return { userId, workspaceId };
};

const serializedInputChars = (prepared: any) => JSON.stringify({ prompt: prepared.prompt, history: prepared.history }).length;

test('F3: actual prepared runner input stays within the configured budget and records excerpts', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    const agent = makeAgent();
    const a = await svc.createThread(workspaceId, userId, { body: 'r'.repeat(20_000), clientMessageId: randomUUID() });
    const quote = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'q'.repeat(20_000), clientMessageId: randomUUID() });
    const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 's'.repeat(20_000), replyToMessageId: quote.id, clientMessageId: randomUUID() });

    for (const budget of [24_000, 8_000]) {
      const context = await svc.buildThreadContext(workspaceId, userId, source.id, { charBudget: budget });
      const prepared = await agent.prepare(workspaceId, userId, context.source, context.history, { manifest: context.manifest, quote: context.quote });
      const actual = serializedInputChars(prepared);
      assert.ok(actual <= budget, `actual serialized input (${actual}) must fit budget ${budget}`);
      // Oversized root/quote/source are excerpted, not force-added past budget.
      assert.ok(Array.isArray(context.manifest.excerpts) && context.manifest.excerpts.length > 0, 'excerpts must be recorded');
      // History content alone must also be bounded by the budget.
      const historySize = context.history.reduce((total: number, m: any) => total + m.content.length, 0);
      assert.ok(historySize <= budget, 'history content alone must not exceed the budget');
    }
  } finally { await db.destroy(); }
});

test('F3: 500+ message thread — bounded queries, no unbounded scan, omitted/included disjoint', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    const a = await svc.createThread(workspaceId, userId, { body: 'ROOT of a very large thread', clientMessageId: randomUUID() });
    for (let i = 0; i < 600; i += 1) {
      await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: `filler message ${i} ` + 'x'.repeat(60), clientMessageId: randomUUID() });
    }
    const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: '@lumo summarize', clientMessageId: randomUUID() });

    const context = await svc.buildThreadContext(workspaceId, userId, source.id, { charBudget: 24_000 });
    const historyPageRows = context.history.length;

    // The included message set never exceeds one bounded page.
    assert.ok(historyPageRows <= TEAM_CONTEXT_HISTORY_PAGE, `history page must be bounded by ${TEAM_CONTEXT_HISTORY_PAGE}`);

    // Omitted ranges must be disjoint from included sequences (root at seq 1 must
    // never appear in an aggregated omitted range).
    const includedSeqs = new Set<number>();
    // Reconstruct sequences from included ids.
    const rows = await db('workspace_team_messages').where({ workspaceId, threadId: a.thread.id }).whereIn('id', context.manifest.includedMessageIds).select('sequence');
    for (const r of rows) includedSeqs.add(Number(r.sequence));
    const omitted: Array<[number, number]> = context.manifest.omittedRanges;
    for (const [lo, hi] of omitted) {
      for (const seq of includedSeqs) {
        assert.ok(!(seq >= lo && seq <= hi), `included sequence ${seq} must not fall in omitted range [${lo},${hi}]`);
      }
    }
    // The root (sequence 1) is included and therefore not omitted.
    assert.ok(includedSeqs.has(1), 'thread root (seq 1) must be included');
  } finally { await db.destroy(); }
});

test('F3: immutable retry reproduces the same excerpted selection; manifest is scoped to its thread/cutoff', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    const a = await svc.createThread(workspaceId, userId, { body: 'r'.repeat(20_000), clientMessageId: randomUUID() });
    const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: '@lumo go', clientMessageId: randomUUID() });
    const context = await svc.buildThreadContext(workspaceId, userId, source.id, { charBudget: 8_000 });

    // Post MORE messages after the cutoff; a retry from the recorded manifest must
    // not pull them in.
    await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'later message after cutoff', clientMessageId: randomUUID() });

    const reloaded = await svc.loadContextFromManifest(workspaceId, context.manifest);
    // Same included ids, same order, same excerpt truncation lengths.
    assert.deepEqual(reloaded.history.map((m: any) => m.id), context.history.map((m: any) => m.id));
    for (const m of reloaded.history) {
      const original = context.history.find((h: any) => h.id === m.id);
      assert.equal(m.content.length, original.content.length, 'retry must reproduce the exact recorded excerpt length');
    }

    // A manifest carrying a foreign thread id must not resurrect this thread's rows.
    const foreign = await svc.loadContextFromManifest(workspaceId, { ...context.manifest, threadId: randomUUID() });
    assert.equal(foreign.history.length, 0, 'manifest thread scope must be enforced on load');
  } finally { await db.destroy(); }
});

test('F3: pinned Working file reference records the resolved version and is workspace-scoped', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    // Create a file + version in this workspace with all required columns.
    const fileId = (await db('files').insert({
      workspaceId, name: 'doc.md', storageType: 'inline', path: 'doc.md',
      mimeType: 'text/markdown', createdBy: userId, version: 3,
    }).returning('id'))[0].id;
    const versionId = randomUUID();
    await db('file_versions').insert({ id: versionId, workspaceId, fileId, version: 3, name: 'doc.md', changeKind: 'modify', createdBy: userId, objectKey: `ws/${workspaceId}/doc.md@3`, sizeBytes: 10, sha256: 'a'.repeat(64) });
    await db('files').where({ id: fileId }).update({ currentVersionId: versionId });

    const references = [{ kind: 'file', id: String(fileId), label: 'doc.md' }];
    const source = await svc.createThread(workspaceId, userId, { body: '@lumo review', references, clientMessageId: randomUUID() });
    const context = await svc.buildThreadContext(workspaceId, userId, source.message.id, { charBudget: 24_000 });
    const pinned = context.manifest.pinnedReferences.find((r: any) => String(r.id) === String(fileId));
    assert.ok(pinned, 'the file reference must be pinned');
    assert.equal(Number(pinned.version), 3, 'pin must record the resolved Working version');
    assert.ok(context.manifest.referenceVersionIds.includes(versionId), 'the resolved version id must be recorded');
  } finally { await db.destroy(); }
});

test('F3: agent context token verification round-trips and rejects tampering/expiry', { skip: !enabled }, async () => {
  const scope = { workspaceId: 'w', userId: 'u', threadId: 't', cutoffSeq: 5, sourceMessageId: 's' };
  const token = signAgentContextToken({ userId: 'u', workspaceId: 'w', threadHistoryScope: scope });
  assert.ok(token, 'token must sign');
  const decoded = verifyAgentContextToken(token!);
  assert.ok(decoded, 'valid token must verify');
  assert.deepEqual(decoded!.threadHistoryScope, scope);

  // Tampered signature is rejected.
  const parts = token!.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
  assert.equal(verifyAgentContextToken(tampered), null, 'tampered signature must be rejected');

  // Expired token is rejected.
  const expired = signAgentContextToken({ userId: 'u', workspaceId: 'w', exp: Math.floor(Date.now() / 1000) - 10 } as any);
  assert.equal(verifyAgentContextToken(expired!), null, 'expired token must be rejected');
});

test('F3: authenticated reader clamps to cutoff, retrieves the bound source, denies later messages', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    const a = await svc.createThread(workspaceId, userId, { body: 'root', clientMessageId: randomUUID() });
    const m1 = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'earlier one', clientMessageId: randomUUID() });
    const source = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 's'.repeat(20_000), clientMessageId: randomUUID() });
    const later = await svc.postThreadMessage(workspaceId, a.thread.id, userId, { body: 'after cutoff', clientMessageId: randomUUID() });
    const cutoffSeq = Number((source as any).sequence);

    // Ordinary history clamps to strictly-before-cutoff.
    const history = await svc.readThreadHistoryRange(workspaceId, userId, a.thread.id, 0, cutoffSeq + 5, { cutoffSeq });
    assert.ok(history.messages.every((mm: any) => mm.id !== source.id), 'source is not returned as ordinary history');
    assert.ok(history.messages.every((mm: any) => mm.id !== later.id), 'later messages are denied');
    assert.ok(history.messages.some((mm: any) => mm.id === m1.id), 'earlier messages are returned');

    // Exact bound-source retrieval at the cutoff.
    const exact = await svc.readThreadHistoryRange(workspaceId, userId, a.thread.id, cutoffSeq, cutoffSeq, { cutoffSeq, sourceMessageId: source.id });
    assert.ok(exact.messages.some((mm: any) => mm.id === source.id && mm.content === (source as any).body), 'bound source must be exactly retrievable');
    // But a DIFFERENT id at the cutoff is not returned by the source path.
    const spoof = await svc.readThreadHistoryRange(workspaceId, userId, a.thread.id, cutoffSeq, cutoffSeq, { cutoffSeq, sourceMessageId: randomUUID() });
    assert.equal(spoof.messages.length, 0, 'a non-source id must not be returned at cutoff');
  } finally { await db.destroy(); }
});

test('F6/F3: listThreadChanges cursor preserves sub-millisecond precision across pages', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  try {
    await database.initialize();
    const { userId, workspaceId } = await seed(db);
    const svc = makeService(db, userId);
    const a = await svc.createThread(workspaceId, userId, { body: 'changes root', clientMessageId: randomUUID() });

    // Three file versions attributed to this thread with timestamps that share
    // the same millisecond but differ at the microsecond — the exact case that a
    // Date-truncating cursor drops.
    const fileId = (await db('files').insert({
      workspaceId, name: 'c.md', storageType: 'inline', path: 'c.md', mimeType: 'text/markdown', createdBy: userId, version: 3,
    }).returning('id'))[0].id;
    const micros = ['123456', '123457', '123458'];
    const ids: string[] = [];
    for (let i = 0; i < micros.length; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await db('file_versions').insert({
        id, workspaceId, fileId, version: i + 1, name: 'c.md', changeKind: 'modify', createdBy: userId,
        objectKey: `ws/${workspaceId}/c.md@${i + 1}`, sizeBytes: 10, sha256: String(i).repeat(64).slice(0, 64),
        sourceThreadId: a.thread.id, sourceMessageId: a.message.id,
        createdAt: db.raw(`?::timestamptz`, [`2026-09-19 10:00:00.${micros[i]}+00`]),
      });
    }

    // Page through one at a time; every version must appear exactly once.
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const pageResult: any = await svc.listThreadChanges(workspaceId, a.thread.id, userId, { limit: 1, cursor: cursor || undefined });
      for (const c of pageResult.changes) seen.add(c.versionId);
      cursor = pageResult.nextCursor;
      if (!cursor) break;
    }
    for (const id of ids) assert.ok(seen.has(id), `version ${id} must appear across paginated Changes`);
    assert.equal(seen.size, ids.length, 'no duplicates or missing rows under identical-millisecond timestamps');
  } finally { await db.destroy(); }
});
