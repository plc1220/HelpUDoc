import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../src/services/databaseService';
import { WorkspaceService } from '../src/services/workspaceService';
import { FileService } from '../src/services/fileService';
import { WorkspacePublicationService } from '../src/services/workspacePublicationService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { WorkspaceTeamChatAgentService } from '../src/services/workspaceTeamChatAgentService';
import { closeWorkspaceMirrorLockPools } from '../src/services/workspaceMirrorLock';

// Real Postgres + MinIO integration for Release B backend F6/F7/F8 + schema
// concurrency + thread-context budget. Gated like the other integration suites.
const enabled = process.env.RUN_THREAD_INTEGRATION === '1' && Boolean(process.env.S3_ENDPOINT);

const build = () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  const ws = new WorkspaceService(ds);
  const files = new FileService(ds, ws);
  const pub = new WorkspacePublicationService(ds, ws);
  const collab = new WorkspaceCollaborationService(ds, ws, pub, files);
  return { ds, db, ws, files, pub, collab };
};

const seedSharedWorkspace = async (db: any) => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db('users').insert({ id: userId, externalId: userId, displayName: 'Release B integration' });
  await db('workspaces').insert({ id: workspaceId, name: 'Release B', slug: workspaceId, ownerId: userId, visibility: 'team', editingPolicy: 'direct' });
  await db('workspace_members').insert({ workspaceId, userId, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
  return { userId, workspaceId };
};

// --- F6: durable provenance + reconciliation -------------------------------

test('B-01/B-02: explicit + run-reconciled provenance, deleted-file immutable bytes, run-filter cursor', { skip: !enabled }, async () => {
  const { ds, db, files, collab } = build();
  await ds.initialize();
  try {
    const { userId, workspaceId } = await seedSharedWorkspace(db);
    const a = await collab.createThread(workspaceId, userId, { body: 'Thread A', clientMessageId: randomUUID() });
    const b = await collab.createThread(workspaceId, userId, { body: 'Thread B', clientMessageId: randomUUID() });

    // Interleaved edits attributed by explicit sourceThreadId.
    const f = await files.createTextFile(workspaceId, 'history.md', 'A_CREATE', userId, 'text/markdown', { sourceThreadId: a.thread.id });
    await files.updateFile(f.id, 'A_MODIFY', userId, undefined, { sourceThreadId: a.thread.id });
    await files.updateFile(f.id, 'B_MODIFY', userId, undefined, { sourceThreadId: b.thread.id });
    let page = await collab.listThreadChanges(workspaceId, a.thread.id, userId, {});
    assert.deepEqual(page.changes.map((x: any) => x.version).sort(), [1, 2]);
    assert.equal(page.changes.find((x: any) => x.version === 2)!.superseded, true);

    // Rename + delete remain discoverable; deleted-file bytes readable.
    await files.renameFile(f.id, { name: 'renamed.md' }, userId, undefined, { sourceThreadId: a.thread.id });
    await files.deleteFile(f.id, userId, { sourceThreadId: a.thread.id });
    page = await collab.listThreadChanges(workspaceId, a.thread.id, userId, {});
    assert.equal(page.changes.length, 4);
    assert.ok(page.changes.some((x: any) => x.changeKind === 'rename' && x.filePath === 'renamed.md'));
    assert.ok(page.changes.some((x: any) => x.changeKind === 'delete'));
    assert.ok(page.changes.every((x: any) => x.fileDeleted));
    const createRec = page.changes.find((x: any) => x.changeKind === 'create')!;
    const bytes = await collab.readThreadChangeVersionBytes(workspaceId, a.thread.id, createRec.versionId, userId, 'after');
    assert.equal(bytes.buffer.toString('utf8'), 'A_CREATE');

    // Foreign-thread association rejected; unassociated stays untagged.
    await assert.rejects(() => files.createTextFile(workspaceId, 'bad.md', 'X', userId, 'text/markdown', { sourceThreadId: randomUUID() }));
    const un = await files.createTextFile(workspaceId, 'unrelated.md', 'UNTAGGED', userId);
    assert.equal((await db('file_versions').where({ fileId: un.id }).first()).sourceThreadId, null);

    // Failed-run reconciliation: runStatus + recovered sourceMessageId + run cursor scope.
    const runId = randomUUID();
    await db('workspace_team_thread_runs').insert({ id: randomUUID(), workspaceId, threadId: a.thread.id, sourceMessageId: a.message.id, runId, status: 'failed', requestedBy: userId, contextCutoffSeq: 1, contextManifest: {} });
    const runfile = await files.createTextFile(workspaceId, 'partial.md', 'BEFORE', userId);
    await files.commitFileBuffer(runfile.id, Buffer.from('COMMITTED_BEFORE_FAILURE'), userId, undefined, { sourceRunId: runId, changeKind: 'artifact' });
    page = await collab.listThreadChanges(workspaceId, a.thread.id, userId, { runId });
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].runStatus, 'failed');
    assert.equal(page.changes[0].sourceMessageId, a.message.id);
  } finally {
    await closeWorkspaceMirrorLockPools();
    await db.destroy();
  }
});

// --- F7: dependency graph, revision race, byte privacy ----------------------

test('B-03: content-reference dependency groups, private-revision race, frozen apply', { skip: !enabled }, async () => {
  const { ds, db, files, pub, collab } = build();
  await ds.initialize();
  try {
    const userId = randomUUID();
    const shared = randomUUID();
    const priv = randomUUID();
    const obj = randomUUID();
    await db('users').insert({ id: userId, externalId: userId, displayName: 'F7 integration' });
    await db('workspaces').insert([
      { id: shared, name: 'S', slug: shared, ownerId: userId, visibility: 'team', editingPolicy: 'direct' },
      { id: priv, name: 'P', slug: priv, ownerId: userId, visibility: 'private', editingPolicy: 'direct' },
    ]);
    await db('workspace_members').insert([{ workspaceId: shared, userId, role: 'owner' }, { workspaceId: priv, userId, role: 'owner' }]).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
    await db('workspace_publication_links').insert({ privateWorkspaceId: priv, teamWorkspaceId: shared, userId });
    await files.createTextFile(shared, 'report.md', '![A](assets/a.png)', userId);
    await files.createTextFile(shared, 'assets/a.png', 'OLD_A', userId, 'image/png');
    // Private report.md DIFFERS from shared (changed text) AND its referenced asset
    // a.png changed, so report.md has a real changed dependency; other.md/b.png are
    // unrelated private work that must never be pulled in.
    await files.createTextFile(priv, 'report.md', 'Updated report\n![A](assets/a.png)', userId);
    await files.createTextFile(priv, 'assets/a.png', 'NEW_A', userId, 'image/png');
    await files.createTextFile(priv, 'other.md', '![B](assets/b.png)', userId);
    await files.createTextFile(priv, 'assets/b.png', 'PRIVATE_B', userId, 'image/png');
    await db('workspace_collaboration_objects').insert({ id: obj, workspaceId: shared, type: 'change_proposal', body: 'P', authorId: userId, linkedPrivateWorkspaceId: priv });
    const sr = Number((await db('workspaces').where({ id: shared }).first()).contentRevision);
    const pr = Number((await db('workspaces').where({ id: priv }).first()).contentRevision);

    // report.md references the CHANGED assets/a.png, so submitting report.md alone
    // is rejected with the missing dependency; submitting both is accepted and the
    // unrelated private assets/b.png is never pulled in.
    await assert.rejects(
      () => collab.submitProposalChangeSet(shared, obj, userId, { expectedSharedRevision: sr, expectedPrivateRevision: pr, selectedOperations: [{ path: 'report.md' }] }),
      (e: any) => e.details?.code === 'MISSING_REQUIRED_DEPENDENCIES',
    );
    const sub = await collab.submitProposalChangeSet(shared, obj, userId, { expectedSharedRevision: sr, expectedPrivateRevision: pr, selectedOperations: [{ path: 'report.md' }, { path: 'assets/a.png' }] });
    assert.deepEqual(sub.operations.map((o: any) => o.path).sort(), ['assets/a.png', 'report.md']);

    // Private-revision pinning: a submission pinned to a STALE expectedPrivateRevision
    // (a concurrent private edit advanced it) is rejected, so unreviewed private
    // bytes can never be frozen under an old revision. (The concurrent-write-DURING-
    // snapshot-read variant is covered by the independent race probe.)
    // Private-revision RACE: a concurrent private write DURING the snapshot read
    // (intercepting the private readWorkspaceContent) must be rejected, so
    // unreviewed private bytes committed after the revision check are never frozen.
    // (Faithful port of the independent dependency-race probe's deterministic
    // injection.)
    const plain = await files.createTextFile(priv, 'plain.md', 'REVIEWED', userId);
    const prPlain = Number((await db('workspaces').where({ id: priv }).first()).contentRevision);
    const srPlain = Number((await db('workspaces').where({ id: shared }).first()).contentRevision);
    const originalRead = (pub as any).readWorkspaceContent.bind(pub);
    let injected = false;
    (pub as any).readWorkspaceContent = async (id: string, ...rest: any[]) => {
      if (id === priv && !injected) { injected = true; await files.updateFile(plain.id, 'UNREVIEWED_AFTER_REVISION_CHECK', userId); }
      return originalRead(id, ...rest);
    };
    try {
      await assert.rejects(() => collab.submitProposalChangeSet(shared, obj, userId, { expectedSharedRevision: srPlain, expectedPrivateRevision: prPlain, selectedOperations: [{ path: 'plain.md' }] }));
      // The frozen submission (if any) never contains the unreviewed bytes.
      const leaked = await db('workspace_proposal_change_sets').where({ objectId: obj }).orderBy('createdAt', 'desc').first();
      if (leaked) {
        const ops = typeof leaked.operations === 'string' ? JSON.parse(leaked.operations) : leaked.operations;
        assert.ok(!ops.some((o: any) => o.path === 'plain.md'), 'unreviewed private write never frozen into a submission');
      }
    } finally {
      (pub as any).readWorkspaceContent = originalRead;
    }

    // Additional coverage: a stale expectedPrivateRevision (advanced by a later
    // edit) is also rejected before any freeze.
    await files.updateFile(plain.id, 'REVIEWED_AGAIN', userId);
    const srNow = Number((await db('workspaces').where({ id: shared }).first()).contentRevision);
    await assert.rejects(
      () => collab.submitProposalChangeSet(shared, obj, userId, { expectedSharedRevision: srNow, expectedPrivateRevision: prPlain, selectedOperations: [{ path: 'plain.md' }] }),
      (e: any) => e.details?.code === 'PRIVATE_STALE',
    );
  } finally {
    await closeWorkspaceMirrorLockPools();
    await db.destroy();
  }
});

// --- F8: anchors, linked items, reattach, references ------------------------

test('B-05: anchor pinning, stale detection, reattach validation, private-annotation refusal', { skip: !enabled }, async () => {
  const { ds, db, files, collab } = build();
  await ds.initialize();
  try {
    const { userId, workspaceId } = await seedSharedWorkspace(db);
    const other = randomUUID();
    await db('users').insert({ id: other, externalId: other, displayName: 'Other' });
    const foreign = randomUUID();
    await db('workspaces').insert({ id: foreign, name: 'F', slug: foreign, ownerId: other, visibility: 'team', editingPolicy: 'direct' });
    await db('workspace_members').insert({ workspaceId: foreign, userId: other, role: 'owner' }).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);

    const t = await collab.createThread(workspaceId, userId, { body: 'Discuss', clientMessageId: randomUUID() });
    const a = await files.createTextFile(workspaceId, 'a.md', 'alpha chosen omega', userId, 'text/markdown');
    const b = await files.createTextFile(workspaceId, 'b.md', 'different content here', userId, 'text/markdown');
    const v1 = (await db('files').where({ id: a.id }).first()).currentVersionId;

    // Path-only create pins current version and persists canonical fileId.
    const ann = await collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'a.md', body: 'Rewrite this', anchorText: 'chosen', anchorStart: 6, anchorEnd: 12, sourceThreadId: t.thread.id });
    assert.equal(ann.anchorVersionId, v1);
    assert.equal(Number(ann.fileId), Number(a.id));

    // Cross-file explicit version rejected.
    const bV = (await db('files').where({ id: b.id }).first()).currentVersionId;
    await assert.rejects(() => collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'a.md', body: 'x', anchorText: 'chosen', anchorStart: 6, anchorEnd: 12, anchorVersionId: bV }));

    // Private annotation cannot be linked.
    await assert.rejects(() => collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'private', body: 'secret', sourceThreadId: t.thread.id }), (e: any) => e.details?.code === 'ANNOTATION_PRIVATE');

    // Edit advances the file: linked item reports anchorChanged with original excerpt.
    await files.updateFile(a.id, 'no matching quote anymore here', userId);
    let items = (await collab.listThreadLinkedItems(workspaceId, t.thread.id, userId)).items;
    const item = items.find((i: any) => i.objectId === ann.id)!;
    assert.equal(item.anchorChanged, true);
    assert.equal(item.anchorText, 'chosen');
    assert.equal(Number(item.currentVersionNumber), 2);

    // Reattach requires a valid new selection; version-only + mismatched excerpt rejected.
    const v2 = (await db('files').where({ id: a.id }).first()).currentVersionId;
    await db('workspace_collaboration_objects').where({ id: ann.id }).update({ status: 'anchor_changed' });
    await assert.rejects(() => collab.reattachAnchor(workspaceId, ann.id, userId, { anchorVersionId: v2 } as any));
    await assert.rejects(() => collab.reattachAnchor(workspaceId, ann.id, userId, { anchorVersionId: v2, anchorStart: 0, anchorEnd: 6, anchorText: 'chosen' }));
    const before = Number((await db('workspace_collaboration_messages').where({ objectId: ann.id }).count('* as ct'))[0].ct);
    const re = await collab.reattachAnchor(workspaceId, ann.id, userId, { anchorVersionId: v2, anchorStart: 0, anchorEnd: 2, anchorText: 'no' });
    assert.equal(re.anchorVersionId, v2);
    const after = Number((await db('workspace_collaboration_messages').where({ objectId: ann.id }).count('* as ct'))[0].ct);
    assert.ok(after > before, 'original anchor preserved as history');

    // Annotation reference: private + foreign rejected.
    const priv = await collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'private', body: 'PRIVATE' });
    await assert.rejects(() => collab.resolveAnnotationReference(workspaceId, userId, { id: priv.id }));
    const fann = await collab.createObject(foreign, other, { type: 'annotation', visibility: 'workspace_audience', body: 'foreign' });
    await assert.rejects(() => collab.resolveAnnotationReference(workspaceId, userId, { id: fann.id }));
  } finally {
    await closeWorkspaceMirrorLockPools();
    await db.destroy();
  }
});

// --- Context budget: escaped content stays within the serialized budget -----

test('F3 budget: actual prepared runner input fits budget; annotation full-bytes materialized; retry frozen; auth rechecked', { skip: !enabled }, async () => {
  const { ds, db, files, pub, collab } = build();
  await ds.initialize();
  const prevSecret = process.env.AGENT_JWT_SECRET;
  process.env.AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET || 'local-release-b-integration-secret';
  try {
    const { userId, workspaceId } = await seedSharedWorkspace(db);
    // Real agent with tiny policy/user fixtures (same pattern as the accepted
    // workspaceTeamChatContext integration test + budget probe). Calls real prepare().
    const agent: any = Object.create(WorkspaceTeamChatAgentService.prototype);
    agent.collaboration = collab;
    agent.files = files;
    agent.publication = pub;
    agent.workspaceService = { getMcpServerPolicy: async () => ({ workspaceMode: 'shared_live', editingPolicy: 'direct', canWriteWorkspace: true, workspaceRole: 'owner' }) };
    agent.userService = { getEffectivePromptAccess: async () => ({ skillIds: [] }), getWorkspaceSkillRuntimePins: async () => [] };

    const escaped = String.fromCharCode(34, 92, 10).repeat(6000); // quotes/backslashes/newlines
    const a = await files.createTextFile(workspaceId, 'a.md', 'alpha chosen omega', userId, 'text/markdown');
    const t = await collab.createThread(workspaceId, userId, { body: 'Thread', clientMessageId: randomUUID() });
    const feedbackBody = 'FROZEN_FEEDBACK ' + escaped;
    const annotation = await collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'a.md', body: feedbackBody, anchorText: 'chosen', anchorStart: 6, anchorEnd: 12, sourceThreadId: t.thread.id });
    const source = await collab.postThreadMessage(workspaceId, t.thread.id, userId, { body: '@Lumo SOURCE_PRIORITY ' + escaped, references: [{ kind: 'annotation', id: annotation.id, label: 'Selected feedback', anchorVersionId: a.currentVersionId } as any], clientMessageId: randomUUID() });

    let lastCtx: any; let lastPrepared: any;
    for (const budget of [8000, 24000]) {
      const ctx = await collab.buildThreadContext(workspaceId, userId, source.id, { charBudget: budget });
      const prepared = await agent.prepare(workspaceId, userId, ctx.source, ctx.history, { manifest: ctx.manifest, quote: ctx.quote });
      // ACTUAL serialized runner input (prompt + history), asserted against the
      // configured budget — NOT a reconstruction of the budget model.
      const size = JSON.stringify({ prompt: prepared.prompt, history: prepared.history }).length;
      assert.ok(size <= budget, `actual serialized input (${size}) must fit budget ${budget}`);
      assert.ok(prepared.prompt.includes('SOURCE_PRIORITY'), 'source question retains priority in the actual prompt');
      // Truncated annotation exposes an exact frozen full-payload reference file.
      const line = prepared.prompt.split('\n').find((x: string) => x.startsWith('{"annotation":'));
      const ref = line ? JSON.parse(line) : null;
      assert.ok(ref?.fullPayloadPath, 'truncated annotation exposes fullPayloadPath');
      const bytes = require('node:fs').readFileSync(require('node:path').join(process.env.WORKSPACE_ROOT, workspaceId, ref.fullPayloadPath), 'utf8');
      assert.equal(JSON.parse(bytes).feedback, feedbackBody.trim(), 'full frozen feedback materialized exactly');
      lastCtx = ctx; lastPrepared = prepared;
    }

    // Mutate the annotation body + reattach the anchor, then re-run prepare() on
    // the SAME saved manifest: the prompt must be byte-identical (frozen), never
    // reflecting the new mutable body/anchor.
    await db('workspace_collaboration_objects').where({ id: annotation.id }).update({ body: 'NEW_FEEDBACK_MUST_NOT_LEAK' });
    const newer = await files.updateFile(a.id, 'different text selected now', userId);
    await collab.reattachAnchor(workspaceId, annotation.id, userId, { anchorVersionId: newer.currentVersionId, anchorStart: 0, anchorEnd: 9, anchorText: 'different' });
    const retry = await agent.prepare(workspaceId, userId, lastCtx.source, lastCtx.history, { manifest: lastCtx.manifest, quote: lastCtx.quote });
    assert.equal(retry.prompt, lastPrepared.prompt, 'retry reproduces the identical frozen prompt after body+anchor edit');

    // Making the annotation private / revoking its share must FAIL the request
    // (typed 403), never silently drop content and succeed.
    await db('workspace_collaboration_objects').where({ id: annotation.id }).update({ visibility: 'private', sourceThreadId: null });
    await assert.rejects(
      () => agent.prepare(workspaceId, userId, lastCtx.source, lastCtx.history, { manifest: lastCtx.manifest, quote: lastCtx.quote }),
      (e: any) => e.statusCode === 403 || e.status === 403,
    );
  } finally {
    if (prevSecret === undefined) delete process.env.AGENT_JWT_SECRET; else process.env.AGENT_JWT_SECRET = prevSecret;
    await closeWorkspaceMirrorLockPools();
    await db.destroy();
  }
});

test('F8 historical anchor identity: old immutable version anchors after rename+recreate; unrelated path rejected', { skip: !enabled }, async () => {
  const { ds, db, files, collab } = build();
  await ds.initialize();
  try {
    const { userId, workspaceId } = await seedSharedWorkspace(db);
    const fileA = await files.createTextFile(workspaceId, 'a.md', 'ORIGINAL A CONTENT', userId, 'text/markdown');
    const fileAv1 = (await db('files').where({ id: fileA.id }).first()).currentVersionId;
    await files.renameFile(fileA.id, { name: 'renamed-a.md' }, userId);
    const fileB = await files.createTextFile(workspaceId, 'a.md', 'BRAND NEW B CONTENT', userId, 'text/markdown');

    // Old published a.md: anchorVersionId=fileA v1 + filePath=a.md must accept the
    // ORIGINAL fileA (the version's recorded name was a.md), not the recreated file.
    const historical = await collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'a.md', body: 'on the original', anchorText: 'ORIGINAL', anchorStart: 0, anchorEnd: 8, anchorVersionId: fileAv1 });
    assert.equal(historical.anchorVersionId, fileAv1);
    assert.equal(Number(historical.fileId), Number(fileA.id), 'anchors the ORIGINAL file, not the recreated one at the same path');

    // The current name of fileA (renamed-a.md) is also accepted for its own version.
    const byCurrentName = await collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'renamed-a.md', body: 'by current name', anchorText: 'ORIGINAL', anchorStart: 0, anchorEnd: 8, anchorVersionId: fileAv1 });
    assert.equal(Number(byCurrentName.fileId), Number(fileA.id));

    // An unrelated nonexistent path paired with fileB's version is rejected.
    const fileBv1 = (await db('files').where({ id: fileB.id }).first()).currentVersionId;
    await assert.rejects(
      () => collab.createObject(workspaceId, userId, { type: 'annotation', visibility: 'workspace_audience', filePath: 'never-related.md', body: 'x', anchorText: 'BRAND', anchorStart: 0, anchorEnd: 5, anchorVersionId: fileBv1 }),
      (e: any) => e.details?.code === 'ANCHOR_FILE_MISMATCH',
    );
  } finally {
    await closeWorkspaceMirrorLockPools();
    await db.destroy();
  }
});

// --- Schema init concurrency ------------------------------------------------

test('schema: concurrent DatabaseService.initialize() is idempotent (no trigger/function catalog race)', { skip: !enabled }, async () => {
  const instances = [new DatabaseService(), new DatabaseService(), new DatabaseService(), new DatabaseService()];
  try {
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.allSettled(instances.map((d) => d.initialize()));
      const failed = results.filter((r) => r.status === 'rejected');
      assert.equal(failed.length, 0, `round ${round} concurrent initialize failed: ${failed.map((f: any) => f.reason?.message).join('; ')}`);
    }
  } finally {
    await Promise.allSettled(instances.map((d) => d.getDb().destroy()));
  }
});
