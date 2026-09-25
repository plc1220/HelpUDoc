import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import knexFactory from 'knex';

import { DatabaseService } from '../src/services/databaseService';
import { WorkspaceService } from '../src/services/workspaceService';
import { FileService } from '../src/services/fileService';
import { WorkspacePublicationService } from '../src/services/workspacePublicationService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { withWorkspaceMirrorLock, closeWorkspaceMirrorLockPools } from '../src/services/workspaceMirrorLock';

// Real Postgres + MinIO integration for Release B frozen submissions/apply.
// Gated: RUN_THREAD_INTEGRATION=1 with S3/MINIO + WORKSPACE_ROOT env set.
const enabled = process.env.RUN_THREAD_INTEGRATION === '1' && Boolean(process.env.S3_ENDPOINT);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '';

const readShared = async (workspaceId: string, name: string) =>
  fs.readFile(path.join(WORKSPACE_ROOT, workspaceId, name), 'utf8');

const setup = async (db: any, files: FileService, collab: WorkspaceCollaborationService) => {
  const userId = randomUUID();
  const sharedId = randomUUID();
  const privateId = randomUUID();
  const objectId = randomUUID();
  await db('users').insert({ id: userId, externalId: userId, displayName: 'B2 fixture' });
  await db('workspaces').insert([
    { id: sharedId, name: 'B2 Shared', slug: sharedId, ownerId: userId, visibility: 'team', editingPolicy: 'direct' },
    { id: privateId, name: 'B2 Private', slug: privateId, ownerId: userId, visibility: 'private', editingPolicy: 'direct' },
  ]);
  await db('workspace_members').insert([
    { workspaceId: sharedId, userId, role: 'owner' },
    { workspaceId: privateId, userId, role: 'owner' },
  ]).onConflict(['workspaceId', 'userId']).ignore().catch(() => undefined);
  await db('workspace_publication_links').insert({ privateWorkspaceId: privateId, teamWorkspaceId: sharedId, userId });
  const sharedFile = await files.createTextFile(sharedId, 'selected.md', 'ORIGINAL_SHARED', userId);
  const privateFile = await files.createTextFile(privateId, 'selected.md', 'SUBMITTED_BYTES', userId);
  await files.createTextFile(privateId, 'unrelated.md', 'PRIVATE_UNRELATED', userId);
  await db('workspace_collaboration_objects').insert({ id: objectId, workspaceId: sharedId, type: 'change_proposal', body: 'Selected proposal', authorId: userId, linkedPrivateWorkspaceId: privateId });
  const shared = await db('workspaces').where({ id: sharedId }).first();
  const priv = await db('workspaces').where({ id: privateId }).first();
  const submitted = await collab.submitProposalChangeSet(sharedId, objectId, userId, {
    expectedSharedRevision: shared.contentRevision,
    expectedPrivateRevision: priv.contentRevision,
    selectedOperations: [{ path: 'selected.md' }],
  });
  // Edit the private copy AFTER submission: frozen snapshot must be unaffected.
  await files.updateFile(privateFile.id, 'PRIVATE_EDIT_AFTER_SUBMISSION', userId);
  const row = await db('workspace_proposal_change_sets').where({ id: submitted.id }).first();
  const operations = typeof row.operations === 'string' ? JSON.parse(row.operations) : row.operations;
  return { userId, sharedId, privateId, objectId, sharedFile, submitted, operations, baseRevision: shared.contentRevision };
};

test('B2: decision-callback failure rolls back BOTH database and disk', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, sharedFile, submitted, operations, baseRevision } = await setup(db, files, collab);
    await assert.rejects(
      () => pub.applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: baseRevision, operations }, async () => { throw new Error('INJECTED_DECISION'); }),
      /INJECTED_DECISION/,
    );
    const after = await db('files').where({ id: sharedFile.id }).first();
    assert.equal(after.version, sharedFile.version, 'DB unchanged');
    assert.equal(await readShared(sharedId, 'selected.md'), 'ORIGINAL_SHARED', 'disk unchanged');
  } finally { await db.destroy(); }
});

test('B2: COMMIT-time deferred failure rolls back BOTH database and disk', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, sharedFile, submitted, operations, baseRevision } = await setup(db, files, collab);
    await assert.rejects(
      () => pub.applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: baseRevision, operations }, async (tx) => {
        // Valid statement now; the deferred root trigger fails at COMMIT.
        await tx('workspace_team_threads').insert({ id: randomUUID(), workspaceId: sharedId, createdBy: userId, title: 'x', rootMessageId: null });
      }),
    );
    const after = await db('files').where({ id: sharedFile.id }).first();
    assert.equal(after.version, sharedFile.version, 'DB unchanged after commit failure');
    assert.equal(await readShared(sharedId, 'selected.md'), 'ORIGINAL_SHARED', 'disk unchanged after commit failure');
  } finally { await db.destroy(); }
});

test('B2: apply uses FROZEN bytes (not later private edits) and never leaks unrelated private files', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, objectId, submitted, baseRevision } = await setup(db, files, collab);
    await collab.applySubmission(sharedId, objectId, userId, { submissionId: submitted.id, expectedSharedRevision: baseRevision });
    assert.equal(await readShared(sharedId, 'selected.md'), 'SUBMITTED_BYTES', 'frozen bytes applied, not the later private edit');
    const names = (await files.getFiles(sharedId, userId)).map((f: any) => f.name);
    assert.ok(!names.includes('unrelated.md'), 'unrelated private file not applied');
  } finally { await db.destroy(); }
});

test('B2: frozen apply survives deletion of the private workspace', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, privateId, objectId, submitted, baseRevision } = await setup(db, files, collab);
    // Delete the private workspace and its link; frozen proposal-owned objects survive.
    await db('workspace_publication_links').where({ privateWorkspaceId: privateId }).del();
    await db('workspaces').where({ id: privateId }).del();
    await collab.applySubmission(sharedId, objectId, userId, { submissionId: submitted.id, expectedSharedRevision: baseRevision });
    assert.equal(await readShared(sharedId, 'selected.md'), 'SUBMITTED_BYTES', 'frozen snapshot applied without the private workspace');
  } finally { await db.destroy(); }
});

test('B2: stale-revision apply is rejected and a concurrent accepted edit survives on disk', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub: any = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, sharedFile, submitted, operations, baseRevision } = await setup(db, files, collab);
    const realTransaction = db.transaction.bind(db);
    // Inject a valid concurrent edit that commits just before apply locks.
    pub.db = new Proxy(db, { get(t: any, k: any) {
      if (k === 'transaction') return async (cb: any) => { pub.db = db; await files.updateFile(sharedFile.id, 'ACCEPTED_CONCURRENT_BYTES', userId); return realTransaction(cb); };
      return Reflect.get(t, k);
    } });
    await assert.rejects(
      () => pub.applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: baseRevision, operations }),
      (e: any) => e.details?.code === 'PROPOSAL_STALE',
    );
    pub.db = db;
    assert.equal(await readShared(sharedId, 'selected.md'), 'ACCEPTED_CONCURRENT_BYTES', 'concurrent accepted edit not clobbered');
  } finally { await db.destroy(); }
});

test('B2: a rollback after a later accepted write does not clobber the newer revision', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub: any = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, sharedFile, submitted, operations } = await setup(db, files, collab);
    const beforeLate = await db('workspaces').where({ id: sharedId }).first();
    const realTransaction = db.transaction.bind(db);
    // A newer accepted write commits AFTER this apply's transaction fails.
    pub.db = new Proxy(db, { get(t: any, k: any) {
      if (k === 'transaction') return async (cb: any) => {
        try { return await realTransaction(cb); }
        catch (error) { pub.db = db; await files.updateFile(sharedFile.id, 'ACCEPTED_AFTER_ROLLBACK', userId); throw error; }
      };
      return Reflect.get(t, k);
    } });
    await assert.rejects(
      () => pub.applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: beforeLate.contentRevision, operations }, async () => { throw new Error('LATE_ROLLBACK'); }),
      /LATE_ROLLBACK/,
    );
    pub.db = db;
    assert.equal(await readShared(sharedId, 'selected.md'), 'ACCEPTED_AFTER_ROLLBACK', 'newer committed revision preserved after rollback rebuild');
  } finally { await db.destroy(); }
});

test('B2: a submission may be applied only once; superseded submission cannot apply', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, privateId, objectId, submitted, baseRevision } = await setup(db, files, collab);
    // Resubmit to produce a newer current submission; the old one is superseded.
    const priv = await db('workspaces').where({ id: privateId }).first();
    const shared2 = await db('workspaces').where({ id: sharedId }).first();
    const submitted2 = await collab.submitProposalChangeSet(sharedId, objectId, userId, {
      expectedSharedRevision: shared2.contentRevision, expectedPrivateRevision: priv.contentRevision,
      selectedOperations: [{ path: 'selected.md' }],
    });
    // Old submission is no longer current -> rejected.
    await assert.rejects(
      () => collab.applySubmission(sharedId, objectId, userId, { submissionId: submitted.id, expectedSharedRevision: baseRevision }),
      (e: any) => e.details?.code === 'SUBMISSION_SUPERSEDED' || e.details?.code === 'PROPOSAL_STALE',
    );
    // Current submission applies once.
    await collab.applySubmission(sharedId, objectId, userId, { submissionId: submitted2.id, expectedSharedRevision: shared2.contentRevision });
    // A second apply of the same submission is rejected.
    await assert.rejects(
      () => collab.applySubmission(sharedId, objectId, userId, { submissionId: submitted2.id, expectedSharedRevision: shared2.contentRevision }),
      (e: any) => e.details?.code === 'SUBMISSION_ALREADY_APPLIED' || e.details?.code === 'PROPOSAL_STALE',
    );
  } finally { await db.destroy(); }
});

test('B2: getSubmission preview never exposes internal object keys or private workspace ids', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, objectId, submitted } = await setup(db, files, collab);
    const preview = await collab.getSubmission(sharedId, objectId, submitted.id, userId);
    const serialized = JSON.stringify(preview);
    assert.ok(!serialized.includes('proposal-snapshots/'), 'no internal object keys leaked');
    assert.ok(!/objectKey|providerVersion|privateWorkspaceId/.test(serialized), 'no storage/private identifiers leaked');
    assert.ok(preview.operations.every((op: any) => op.path && op.changeKind), 'reviewable fields present');
  } finally { await db.destroy(); }
});

test('B2: a write accepted DURING the failure rebuild survives (versioned materialization)', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub: any = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, sharedFile, submitted, operations } = await setup(db, files, collab);
    const beforeRebuild = await db('workspaces').where({ id: sharedId }).first();

    // Hook readWorkspaceContent so that, during the rebuild triggered by the
    // apply failure, a concurrent writer commits a newer accepted revision after
    // the rebuild's content snapshot is taken. The versioned materialization
    // protocol must detect the revision change and materialize the newer bytes
    // instead of clobbering them with the stale snapshot.
    const realRead = pub.readWorkspaceContent.bind(pub);
    let injectRebuild = false;
    pub.readWorkspaceContent = async (...args: any[]) => {
      const snapshot = await realRead(...args);
      if (injectRebuild) {
        injectRebuild = false;
        await files.updateFile(sharedFile.id, 'ACCEPTED_DURING_REBUILD', userId);
      }
      return snapshot;
    };

    await assert.rejects(
      () => pub.applySubmittedChangeSet(
        null,
        sharedId,
        userId,
        { submissionId: submitted.id, baseSharedRevision: beforeRebuild.contentRevision, operations },
        async () => { injectRebuild = true; throw new Error('REBUILD_RACE'); },
      ),
      /REBUILD_RACE/,
    );

    pub.readWorkspaceContent = realRead;
    assert.equal(
      await readShared(sharedId, 'selected.md'),
      'ACCEPTED_DURING_REBUILD',
      'write accepted during the rebuild survives; stale snapshot did not clobber it',
    );
    // The on-disk mirror must match the authoritative DB revision (no divergence).
    const finalWorkspace = await db('workspaces').where({ id: sharedId }).first();
    assert.ok(Number(finalWorkspace.contentRevision) > Number(beforeRebuild.contentRevision), 'a newer revision was accepted');
  } finally { await db.destroy(); }
});

// Ported from the reviewer's updated probe-submission.cjs scheduling
// (NEWER_APPLY_SURVIVES_DELAYED_WRITER). The competing apply runs AFTER the
// writer's SQL commit but BEFORE the writer acquires the mirror lock for its
// canonical materialization — no lock is held while awaiting the apply. The
// delayed writer must then materialize the CURRENT canonical version (the
// applied frozen bytes), never its own stale buffer.
test('B2: a delayed file writer materializes the CURRENT canonical version (no lost apply)', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files: any = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, objectId, sharedFile, submitted, operations } = await setup(db, files, collab);

    const filesTransaction = files.db.transaction.bind(files.db);
    let injectedApply = false;
    // After the writer's commit resolves (SQL persisted) but before it acquires
    // the mirror lock, run a newer apply at the current revision.
    files.db = new Proxy(db, {
      get(target: any, key: any) {
        if (key === 'transaction') return async (callback: any) => {
          const result = await filesTransaction(callback);
          files.db = db;
          injectedApply = true;
          const currentRevision = await db('workspaces').where({ id: sharedId }).first();
          await pub.applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: currentRevision.contentRevision, operations });
          return result;
        };
        return Reflect.get(target, key);
      },
    });

    await files.updateFile(sharedFile.id, 'DELAYED_WRITER_BYTES', userId);
    files.db = db;

    assert.ok(injectedApply, 'competing apply ran between the writer commit and its mirror materialization');
    const disk = await readShared(sharedId, 'selected.md');
    assert.equal(disk, 'SUBMITTED_BYTES', 'delayed writer materialized the newest canonical version, not its stale buffer');
    // Explicit no-divergence check: disk equals the current DB canonical version.
    const fileRow = await db('files').where({ id: sharedFile.id }).first();
    const versionRow = await db('file_versions').where({ id: fileRow.currentVersionId }).first();
    assert.equal(
      String(versionRow.sha256),
      createHash('sha256').update(disk).digest('hex'),
      'on-disk mirror matches the canonical DB version hash (no SQL/disk divergence)',
    );
  } finally { await db.destroy(); }
});

// Ported from the reviewer's APPLY_HONORS_MIRROR_LOCK probe case: a held mirror
// lock must block an apply's disk swap until released.
test('B2: apply honors the shared mirror lock (blocks while a lock is held)', { skip: !enabled }, async () => {
  const ds = new DatabaseService();
  const db = ds.getDb();
  try {
    await ds.initialize();
    const ws = new WorkspaceService(ds);
    const files = new FileService(ds, ws);
    const pub = new WorkspacePublicationService(ds, ws);
    const collab = new WorkspaceCollaborationService(ds, ws, pub);
    const { userId, sharedId, submitted, operations } = await setup(db, files, collab);

    let signalEntered: () => void = () => {};
    let releaseLock: () => void = () => {};
    const entered = new Promise<void>((r) => { signalEntered = r; });
    const gate = new Promise<void>((r) => { releaseLock = r; });
    const holder = withWorkspaceMirrorLock(db, sharedId, async () => { signalEntered(); await gate; });
    await entered;

    const latestShared = await db('workspaces').where({ id: sharedId }).first();
    let applySettled = false;
    const waitingApply = pub
      .applySubmittedChangeSet(null, sharedId, userId, { submissionId: submitted.id, baseSharedRevision: latestShared.contentRevision, operations })
      .finally(() => { applySettled = true; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(applySettled, false, 'apply must wait for the held mirror lock');
    releaseLock();
    await Promise.all([holder, waitingApply]);
    assert.equal(await readShared(sharedId, 'selected.md'), 'SUBMITTED_BYTES', 'apply completes after the lock is released');
  } finally { await db.destroy(); }
});

// Regression for the dedicated advisory-lock pool: concurrent lock holders whose
// callbacks themselves query the DB must not exhaust the data pool. This mirrors
// probe-mirror-pool.cjs but uses a tiny data pool (max 2) so a shared-pool
// implementation would deadlock, while the dedicated lock pool succeeds.
test('mirror lock: concurrent holders with DB-querying callbacks do not exhaust the data pool', { skip: !enabled }, async () => {
  const smallPool = knexFactory({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 2 },
    acquireConnectionTimeout: 2000,
  });
  try {
    let entered = 0;
    let release: () => void = () => {};
    const bothEntered = new Promise<void>((r) => { release = r; });
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((workspaceId) =>
        withWorkspaceMirrorLock(smallPool, workspaceId, async () => {
          entered += 1;
          if (entered === 2) release();
          await bothEntered;
          // Callback needs a data-pool connection while the lock is held.
          await smallPool.raw('SELECT 1');
        }),
      ),
    );
    for (const r of results) {
      assert.equal(r.status, 'fulfilled', `holder failed: ${(r as PromiseRejectedResult).reason?.message}`);
    }
  } finally {
    await smallPool.destroy();
    await closeWorkspaceMirrorLockPools();
  }
});

