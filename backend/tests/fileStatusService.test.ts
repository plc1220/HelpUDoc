import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError, ConflictError, NotFoundError } from '../src/errors';
import {
  approveFilesOnProposalAccepted,
  FileStatusService,
  flushFileStatusEvents,
  queueFileStatusEvent,
  allowedTransitionsFor,
  hasDrifted,
  normalizeFileStatus,
  isFileContentProtected,
} from '../src/services/fileStatusService';
import { readPayload } from './helpers/auditHarness';

// --- pure helpers ------------------------------------------------------------

test('unknown or missing statuses fall back to draft', () => {
  assert.equal(normalizeFileStatus('approved'), 'approved');
  assert.equal(normalizeFileStatus(undefined), 'draft');
  assert.equal(normalizeFileStatus('nonsense'), 'draft');
  // A row written before the column existed reads as draft, not as broken.
  assert.equal(normalizeFileStatus(null), 'draft');
});

test('drift is content moving on after a decision', () => {
  assert.equal(hasDrifted({ status: 'approved', version: 4, approvedAtVersion: 4 }), false);
  assert.equal(hasDrifted({ status: 'approved', version: 7, approvedAtVersion: 4 }), true);
  assert.equal(hasDrifted({ status: 'published', version: 2, publishedAtVersion: 1 }), true);
  // Nothing has been decided yet, so nothing can have drifted.
  assert.equal(hasDrifted({ status: 'draft', version: 9, approvedAtVersion: 1 }), false);
  assert.equal(hasDrifted({ status: 'in_review', version: 9 }), false);
});

test('the transition menu reflects the role', () => {
  const asViewer = allowedTransitionsFor('draft', 'viewer', false, true);
  assert.deepEqual(asViewer, [], 'a viewer can move nothing');

  const asContributor = allowedTransitionsFor('draft', 'contributor', false, true);
  assert.deepEqual(asContributor.map((t) => t.toStatus), ['in_review']);

  // An editor may also sign a draft off directly, skipping review.
  assert.deepEqual(
    allowedTransitionsFor('draft', 'editor', false, true).map((t) => t.toStatus).sort(),
    ['approved', 'in_review'],
  );

  // A contributor may submit but must not approve.
  assert.deepEqual(allowedTransitionsFor('in_review', 'contributor', false, true), []);
  assert.deepEqual(
    allowedTransitionsFor('in_review', 'editor', false, true).map((t) => t.toStatus).sort(),
    ['approved', 'draft'],
  );
});

test('the author of a file in review may pull it back', () => {
  // Not an approver, but it is their own submission.
  const menu = allowedTransitionsFor('in_review', 'contributor', true, true);
  assert.deepEqual(menu.map((t) => t.toStatus), ['draft']);
  assert.equal(menu[0].promptsForReason, true);
  assert.equal(menu[0].isRevert, true);
});

test('reverts are flagged and require a reason; forward moves do not', () => {
  const fromDraft = allowedTransitionsFor('draft', 'editor', false, true);
  const submit = fromDraft.find((t) => t.toStatus === 'in_review')!;
  assert.equal(submit.isRevert, false);
  assert.equal(submit.promptsForReason, false);

  // The one forward move that asks for a reason: it reaches a signed-off,
  // read-only state without anybody having reviewed it.
  const approveDirect = fromDraft.find((t) => t.toStatus === 'approved')!;
  assert.equal(approveDirect.isRevert, false);
  assert.equal(approveDirect.promptsForReason, true);

  // From approved there is one forward move (publish) and the rest go back.
  for (const t of allowedTransitionsFor('approved', 'editor', false, true)) {
    if (t.toStatus === 'published') {
      assert.equal(t.isRevert, false, 'publishing moves the file forward');
      assert.equal(t.promptsForReason, false);
      continue;
    }
    assert.equal(t.isRevert, true, `${t.toStatus} must be marked a revert`);
    assert.equal(t.promptsForReason, true, `${t.toStatus} must require a reason`);
  }
});

test('only a publisher can unpublish', () => {
  assert.deepEqual(allowedTransitionsFor('published', 'contributor', false, true), []);
  assert.deepEqual(
    allowedTransitionsFor('published', 'owner', false, true).map((t) => t.toStatus).sort(),
    ['approved', 'draft', 'in_review'],
  );
});

test('a private workspace stops at approved', () => {
  // Publishing exports an immutable artifact to the shared release bucket, so
  // it is a team act. Everything up to approval still works privately.
  assert.deepEqual(
    allowedTransitionsFor('draft', 'owner', false, false).map((t) => t.toStatus).sort(),
    ['approved', 'in_review'],
  );
  assert.deepEqual(
    allowedTransitionsFor('approved', 'owner', false, false).map((t) => t.toStatus).sort(),
    ['draft', 'in_review'],
    'approved offers only the ways back, never publish',
  );
});

test('a published status inherited into a private workspace is read-only', () => {
  // It arrives by syncing from the Shared workspace. Moving out of it here
  // would imply withdrawing an artifact this workspace does not own.
  assert.deepEqual(allowedTransitionsFor('published', 'owner', false, false), []);
});

// --- the service ------------------------------------------------------------

type Row = Record<string, any>;

function makeService(
  file: Row,
  role = 'editor',
  opts?: { requireEditDenied?: boolean; privateWorkspace?: boolean },
) {
  const files = [file];
  const auditEvents: Row[] = [];
  const governanceEvents: Row[] = [];

  const table = (name: string) => {
    let rows: Row[] = name === 'files' ? files : [];
    const api: any = {
      where(clause: Row) {
        rows = rows.filter((r) => Object.entries(clause).every(([k, v]) => r[k] === v));
        return api;
      },
      whereNull(col: string) { rows = rows.filter((r) => r[col] == null); return api; },
      whereIn(col: string, values: unknown[]) {
        rows = rows.filter((r) => values.includes(r[col]));
        return api;
      },
      select() { return api; },
      async first() { return rows[0]; },
      async insert(row: Row) {
        if (name === 'file_audit_events') auditEvents.push(row);
        if (name === 'audit_events') governanceEvents.push(row);
        return [row];
      },
      update(patch: Row) {
        for (const r of rows) Object.assign(r, patch);
        const result: any = {
          returning: async () => rows,
          then: (res: any) => Promise.resolve(rows).then(res),
        };
        return result;
      },
      then(res: any, rej: any) { return Promise.resolve(rows).then(res, rej); },
    };
    return api;
  };

  const db: any = (name: string) => table(name);
  db.fn = { now: () => new Date('2026-08-28T00:00:00Z') };
  db.raw = (sql: string, bindings: unknown[] = []) => ({ __raw: sql, bindings });
  db.transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  // withGovernanceLock reaches for a real connection; stub it out.
  db.client = {
    acquireConnection: async () => ({ query: async () => undefined }),
    releaseConnection: async () => undefined,
  };

  const service = Object.create(FileStatusService.prototype) as FileStatusService;
  Object.assign(service, {
    db,
    workspaceService: {
      ensureMembership: async (_ws: string, _u: string, options?: { requireEdit?: boolean }) => {
        if (options?.requireEdit && opts?.requireEditDenied) {
          throw new AccessDeniedError('Read-only');
        }
        // Shared unless a test says otherwise: publishing is a team act, and
        // most of these cases exercise the publish path.
        return {
          workspace: {
            id: file.workspaceId,
            visibility: opts?.privateWorkspace ? 'private' : 'team',
            workspaceType: opts?.privateWorkspace ? 'private' : 'team',
          },
          membership: { role },
        };
      },
    },
  });
  return { service, files, auditEvents, governanceEvents };
}

const baseFile = (over: Row = {}): Row => ({
  id: 412,
  workspaceId: 'ws-1',
  name: 'reports/q3.md',
  version: 4,
  status: 'draft',
  createdBy: 'u-alice',
  updatedBy: 'u-alice',
  currentVersionId: 'fv-4',
  auditSeq: 3,
  lastAuditHash: 'a'.repeat(64),
  deletedAt: null,
  ...over,
});

test('submitting for review records both the trail and the governance row', async () => {
  const { service, files, auditEvents, governanceEvents } = makeService(baseFile(), 'contributor');
  const state = await service.transition(412, 'u-alice', { toStatus: 'in_review' });

  assert.equal(state.status, 'in_review');
  assert.equal(files[0].status, 'in_review');
  assert.equal(files[0].statusUpdatedBy, 'u-alice');

  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].eventType, 'status.submitted');
  assert.equal(auditEvents[0].seq, 4, 'continues the file chain');

  assert.equal(governanceEvents.length, 1);
  assert.equal(governanceEvents[0].action, 'file.status.submitted');
  assert.equal(governanceEvents[0].resourceType, 'file');
  assert.equal(governanceEvents[0].resourceId, '412');
});

test('illegal transitions are refused', async () => {
  // `published` is the one state that is not freely reachable: it exports an
  // immutable artifact, so a status flag alone would claim something shipped.
  // Publishing is configured here so the rule table is what refuses, not the
  // server-configuration check that fires ahead of it.
  const { service } = makeService(baseFile({ status: 'draft' }), 'owner');
  (service as any).publicationService = { publishArtifact: async () => { throw new Error('unreachable'); } };
  await assert.rejects(
    () => service.transition(412, 'u-bob', { toStatus: 'published' }),
    (e: unknown) => e instanceof ConflictError && /Cannot move a file from draft to published/.test((e as Error).message),
  );
});

test('a draft can be approved directly, with or without a reason', async () => {
  // The reason is recorded when given, never demanded: the transition is
  // already an audited decision carrying actor, time and from/to.
  const withoutReason = makeService(baseFile({ status: 'draft' }), 'owner');
  const bare = await withoutReason.service.transition(412, 'u-bob', { toStatus: 'approved' });
  assert.equal(bare.status, 'approved');

  const { service, files } = makeService(baseFile({ status: 'draft', version: 5 }), 'owner');
  const state = await service.transition(412, 'u-bob', {
    toStatus: 'approved',
    reason: 'Signed off without review; agreed at standup',
  });
  assert.equal(state.status, 'approved');
  assert.equal(files[0].approvedAtVersion, 5, 'the decision pins the version it applies to');
});

test('a no-op transition is refused rather than silently accepted', async () => {
  const { service } = makeService(baseFile({ status: 'in_review' }), 'editor');
  await assert.rejects(
    () => service.transition(412, 'u-bob', { toStatus: 'in_review' }),
    (e: unknown) => e instanceof ConflictError && /already in_review/.test((e as Error).message),
  );
});

test('a contributor cannot approve', async () => {
  const { service } = makeService(baseFile({ status: 'in_review' }), 'contributor');
  await assert.rejects(
    () => service.transition(412, 'u-carol', { toStatus: 'approved' }),
    (e: unknown) => e instanceof AccessDeniedError,
  );
});

test('a publisher may approve a file they last edited, and it is recorded', async () => {
  // The old guard could only ever catch a Publisher: `canApprove` belongs to
  // `editor` and `owner` alone, everyone else is refused by the capability
  // check first, and the owner was already exempt. Approval authority now
  // includes vouching for your own work — but the trail still says so.
  const { service, governanceEvents } = makeService(
    baseFile({ status: 'in_review', updatedBy: 'u-editor' }), 'editor',
  );
  const state = await service.transition(412, 'u-editor', { toStatus: 'approved' });
  assert.equal(state.status, 'approved');
  assert.equal(governanceEvents[0].selfApproved, true);
});

test('an owner may override self-approval', async () => {
  const { service, governanceEvents } = makeService(
    baseFile({ status: 'in_review', updatedBy: 'u-owner' }), 'owner',
  );
  const state = await service.transition(412, 'u-owner', { toStatus: 'approved' });
  assert.equal(state.status, 'approved');
  // The override is recorded, not hidden.
  assert.equal(governanceEvents[0].selfApproved, true);
});

test('approving pins the version it applies to', async () => {
  const { service, files } = makeService(baseFile({ status: 'in_review', updatedBy: 'u-alice' }), 'editor');
  const state = await service.transition(412, 'u-bob', { toStatus: 'approved' });
  assert.equal(state.approvedAtVersion, 4);
  assert.equal(files[0].approvedAtVersion, 4);
  assert.equal(state.drift, false);
});

test('editing after approval shows as drift', async () => {
  const { service } = makeService(
    baseFile({ status: 'approved', version: 7, approvedAtVersion: 4 }), 'editor',
  );
  const state = await service.getStatus(412, 'u-bob');
  assert.equal(state.drift, true, 'approved at v4 but now at v7');
  assert.equal(state.status, 'approved', 'status must not silently change');
});

test('a revert records its reason and the version it applied to', async () => {
  const { service, auditEvents, governanceEvents, files } = makeService(
    baseFile({ status: 'approved', version: 7, approvedAtVersion: 4 }), 'editor',
  );

  const state = await service.transition(412, 'u-bob', {
    toStatus: 'draft', reason: 'Figure 3 changed after sign-off',
  });
  assert.equal(state.status, 'draft');
  // The stale approval must not linger.
  assert.equal(files[0].approvedAtVersion, null);
  assert.equal(state.drift, false);

  const payload = auditEvents[0].payload.bindings
    ? JSON.parse(auditEvents[0].payload.bindings[0])
    : auditEvents[0].payload;
  assert.equal(payload.reason, 'Figure 3 changed after sign-off');
  assert.equal(payload.isRevert, true);
  assert.equal(payload.fileVersion ?? auditEvents[0].fileVersion, 7);
  assert.equal(auditEvents[0].fileVersionId, 'fv-4');
  assert.equal(governanceEvents[0].reason, 'Figure 3 changed after sign-off');
});

test('a revert without a reason still goes through, recording none', async () => {
  // The move is already an audited decision with an actor, a time and a
  // from/to pair. Refusing it over a missing note gated the work without
  // adding a fact.
  const { service, governanceEvents, files } = makeService(
    baseFile({ status: 'approved', version: 7, approvedAtVersion: 4 }), 'editor',
  );
  const state = await service.transition(412, 'u-bob', { toStatus: 'draft' });
  assert.equal(state.status, 'draft');
  assert.equal(files[0].approvedAtVersion, null, 'the stale approval still clears');
  assert.equal(governanceEvents[0].reason, null);
});

test('publishing is refused when no publication target is configured', async () => {
  // The status must never claim an export that could not have happened.
  const { service } = makeService(baseFile({ status: 'approved' }), 'owner');
  await assert.rejects(
    () => service.transition(412, 'u-owner', { toStatus: 'published' }),
    (e: unknown) => e instanceof ConflictError && /not configured/.test((e as Error).message),
  );
});

test('publishing exports an artifact and records where it went', async () => {
  const harness = makeService(baseFile({ status: 'approved', version: 4 }), 'owner');
  const published: Array<{ fileId: number; userId: string }> = [];
  (harness.service as any).publicationService = {
    publishArtifact: async (fileId: number, userId: string) => {
      published.push({ fileId, userId });
      return {
        id: 'pub-1', fileId, workspaceId: 'ws-1', publicationVersion: 1,
        sourcePath: 'reports/q3.md', publishedName: 'reports/q3-v1.md',
        targetBucket: 'published', targetKey: 'ws-1/reports/q3-v1.md',
        targetUri: 'gs://published/ws-1/reports/q3-v1.md',
        sha256: 'abc123', sizeBytes: 12, reused: false,
      };
    },
  };

  const state = await harness.service.transition(412, 'u-owner', { toStatus: 'published' });

  assert.equal(state.status, 'published');
  assert.deepEqual(published, [{ fileId: 412, userId: 'u-owner' }], 'the artifact is exported');
  assert.equal(harness.files[0].publishedAtVersion, 4, 'pins the version that went out');
  assert.equal(harness.files[0].currentPublicationId, 'pub-1');
  assert.equal(harness.files[0].publicationVersion, 1);

  const payload = harness.auditEvents[0].payload.bindings
    ? JSON.parse(harness.auditEvents[0].payload.bindings[0])
    : harness.auditEvents[0].payload;
  assert.equal(payload.publishedName, 'reports/q3-v1.md');
  assert.equal(payload.targetUri, 'gs://published/ws-1/reports/q3-v1.md');
  assert.equal(payload.artifactSha256, 'abc123');
});

test('a private workspace cannot publish, and cannot leave an inherited published', async () => {
  const approved = makeService(
    baseFile({ status: 'approved', version: 4, approvedAtVersion: 4 }),
    'owner',
    { privateWorkspace: true },
  );
  await assert.rejects(
    () => approved.service.transition(412, 'u-owner', { toStatus: 'published' }),
    /Only a Shared workspace can publish/,
  );
  assert.equal(approved.files[0].status, 'approved', 'the file did not move');

  // Synced in from the Shared workspace: shown, but not ours to withdraw.
  const inherited = makeService(
    baseFile({ status: 'published', version: 4, publishedAtVersion: 4 }),
    'owner',
    { privateWorkspace: true },
  );
  await assert.rejects(
    () => inherited.service.transition(412, 'u-owner', {
      toStatus: 'approved', reason: 'trying to withdraw from a private copy',
    }),
    /Only a Shared workspace can publish/,
  );
});

test('withdrawing marks the publication but never deletes the artifact', async () => {
  const harness = makeService(
    baseFile({ status: 'published', version: 4, publishedAtVersion: 4, currentPublicationId: 'pub-1' }),
    'owner',
  );
  const state = await harness.service.transition(412, 'u-owner', {
    toStatus: 'approved', reason: 'withdrawn pending review',
  });

  assert.equal(state.status, 'approved');
  assert.equal(harness.files[0].currentPublicationId, null, 'no longer the current publication');
  assert.equal(harness.files[0].publishedAtVersion, null);
  // The artifact itself is immutable; nothing in this path removes it.
});

test('a stale expectedVersion is rejected', async () => {
  const { service } = makeService(baseFile({ status: 'in_review', updatedBy: 'u-alice' }), 'editor');
  await assert.rejects(
    () => service.transition(412, 'u-bob', { toStatus: 'approved', expectedVersion: 2 }),
    (e: unknown) => e instanceof ConflictError && /changed since you loaded it/.test((e as Error).message),
  );
});

test('read-only members cannot transition anything', async () => {
  const { service } = makeService(baseFile(), 'viewer', { requireEditDenied: true });
  await assert.rejects(
    () => service.transition(412, 'u-viewer', { toStatus: 'in_review' }),
    (e: unknown) => e instanceof AccessDeniedError,
  );
});

test('a missing file is a 404', async () => {
  const { service } = makeService(baseFile({ deletedAt: '2026-08-01' }), 'owner');
  await assert.rejects(
    () => service.transition(412, 'u-owner', { toStatus: 'in_review' }),
    (e: unknown) => e instanceof NotFoundError,
  );
});

// --- accepting a change proposal --------------------------------------------

/** A minimal transaction over a fixed set of files rows. */
function fakeTx(files: Row[]) {
  const auditEvents: Row[] = [];
  const governanceEvents: Row[] = [];
  const raws: string[] = [];

  const table = (name: string) => {
    let rows: Row[] = name === 'files' ? files : [];
    const api: any = {
      where(clause: Row) {
        rows = rows.filter((r) => Object.entries(clause).every(([k, v]) => r[k] === v));
        return api;
      },
      whereIn(col: string, values: unknown[]) {
        rows = rows.filter((r) => values.includes(r[col]));
        return api;
      },
      whereNull(col: string) { rows = rows.filter((r) => r[col] == null); return api; },
      async insert(row: Row) {
        if (name === 'file_audit_events') auditEvents.push(row);
        if (name === 'audit_events') governanceEvents.push(row);
        return [row];
      },
      update(patch: Row) {
        for (const r of rows) Object.assign(r, patch);
        return { then: (res: any) => Promise.resolve(rows).then(res) } as any;
      },
      then(res: any, rej: any) { return Promise.resolve(rows).then(res, rej); },
    };
    return api;
  };

  const tx: any = (name: string) => table(name);
  tx.raw = (sql: string, bindings: unknown[] = []) => {
    raws.push(sql);
    return { __raw: sql, bindings };
  };
  tx.fn = { now: () => new Date('2026-09-02T00:00:00Z') };
  return { tx, auditEvents, governanceEvents, raws };
}

const proposalFile = (over: Row = {}): Row => ({
  id: 701,
  name: 'reports/q3.md',
  workspaceId: 'ws-shared',
  version: 6,
  status: 'in_review',
  currentVersionId: 'fv-6',
  auditSeq: 3,
  lastAuditHash: 'hash-3',
  deletedAt: null,
  ...over,
});

test('accepting a proposal approves the files that were under review', async () => {
  const files = [proposalFile()];
  const h = fakeTx(files);

  const approved = await approveFilesOnProposalAccepted(h.tx, {
    workspaceId: 'ws-shared',
    fileIds: [701],
    userId: 'u-reviewer',
    role: 'editor' as any,
  });

  assert.deepEqual(approved, [701]);
  assert.equal(files[0].status, 'approved');
  assert.equal(files[0].approvedAtVersion, 6, 'pins the version that was accepted');
  assert.equal(files[0].statusUpdatedBy, 'u-reviewer');

  const event = h.auditEvents[0];
  assert.equal(event.eventType, 'status.approved');
  assert.equal(event.seq, 4, 'continues the file chain');
  const payload = readPayload(event as any);
  assert.equal(payload.viaProposalAccept, true);
  // Applying the content makes the accepter `updatedBy`, so the exemption from
  // the self-approval rule has to be recorded rather than implied.
  assert.equal(payload.selfApproved, false);

  assert.equal(h.governanceEvents.length, 1, 'mirrored into the governance log');
  assert.equal(h.governanceEvents[0].action, 'file.status.approved');
  assert.ok(h.raws.some((sql) => sql.includes('pg_advisory_xact_lock')), 'locks each file');
});

test('accepting a proposal leaves files nobody submitted alone', async () => {
  // A draft can ride along in the same proposal; it was never under review.
  const files = [
    proposalFile({ id: 702, status: 'draft' }),
    proposalFile({ id: 703, status: 'approved' }),
  ];
  const h = fakeTx(files);

  const approved = await approveFilesOnProposalAccepted(h.tx, {
    workspaceId: 'ws-shared',
    fileIds: [702, 703],
    userId: 'u-reviewer',
    role: 'editor' as any,
  });

  assert.deepEqual(approved, []);
  assert.equal(files[0].status, 'draft');
  assert.equal(files[1].status, 'approved');
  assert.equal(h.auditEvents.length, 0);
});

// --- announcing a change to other sessions -----------------------------------

/**
 * Stand-in for the `users` lookup the announcement makes, recording what it was
 * asked for. Redis is closed under test, so publishing is already a no-op; the
 * lookup is what shows whether a flush had anything to say.
 */
const usersStub = (rows: Array<{ id: string; displayName: string }> = []) => {
  const lookups: string[][] = [];
  const db = (table: string) => {
    assert.equal(table, 'users');
    return {
      whereIn: (_column: string, ids: string[]) => {
        lookups.push([...ids]);
        return { select: async () => rows };
      },
    };
  };
  return { db: db as never, lookups };
};

const statusEvent = (fileId: number) => ({
  workspaceId: 'ws-1',
  fileId,
  fileName: `file-${fileId}.md`,
  fromStatus: 'draft' as const,
  toStatus: 'in_review' as const,
  actorUserId: `user-${fileId}`,
  at: '2026-01-01T00:00:00.000Z',
});

test('a change is announced only when its transaction is flushed', async () => {
  const { db, lookups } = usersStub([{ id: 'user-1', displayName: 'Ada Reviewer' }]);
  const tx = {};

  queueFileStatusEvent(tx, statusEvent(1));
  assert.deepEqual(lookups, [], 'queueing alone must not reach out to anything');

  await flushFileStatusEvents(db, tx);
  assert.deepEqual(lookups, [['user-1']], 'the flush resolves the actor it queued');
});

test('flushing twice does not announce the same change again', async () => {
  const { db, lookups } = usersStub();
  const tx = {};

  queueFileStatusEvent(tx, statusEvent(1));
  await flushFileStatusEvents(db, tx);
  await flushFileStatusEvents(db, tx);

  assert.equal(lookups.length, 1, 'the queue is taken on the first flush');
});

test('a transaction that queued nothing needs no lookup', async () => {
  const { db, lookups } = usersStub();

  await flushFileStatusEvents(db, {});

  assert.deepEqual(lookups, []);
});

test('each transaction keeps its own queue', async () => {
  const { db, lookups } = usersStub();
  const first = {};
  const second = {};

  queueFileStatusEvent(first, statusEvent(1));
  queueFileStatusEvent(second, statusEvent(2));
  await flushFileStatusEvents(db, first);

  // Only the flushed transaction's actor is resolved; the other queue is intact.
  assert.deepEqual(lookups, [['user-1']]);

  await flushFileStatusEvents(db, second);
  assert.deepEqual(lookups, [['user-1'], ['user-2']]);
});

test('one lookup covers every actor in a flush', async () => {
  const { db, lookups } = usersStub();
  const tx = {};

  queueFileStatusEvent(tx, statusEvent(1));
  queueFileStatusEvent(tx, statusEvent(2));
  queueFileStatusEvent(tx, { ...statusEvent(3), actorUserId: 'user-1' });
  await flushFileStatusEvents(db, tx);

  // A sync touching many files must not become one query per file, and a
  // repeated actor is asked for once.
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].sort(), ['user-1', 'user-2']);
});

// ─── Signed-off files are read-only ──────────────────────────────────────────
//
// Status used to be a record rather than a lock: approval pinned a version,
// editing bumped past it, and the only trace was a drift badge. An agent run
// would overwrite a document a publisher had signed off.

const shared = { visibility: 'team' as const, workspaceType: 'team' as const };
const privateWs = { visibility: 'private' as const, workspaceType: 'private' as const };

test('approved and published refuse content writes; draft and in_review do not', () => {
  assert.equal(isFileContentProtected({ status: 'approved' }, shared), true);
  assert.equal(isFileContentProtected({ status: 'published' }, shared), true);
  assert.equal(isFileContentProtected({ status: 'in_review' }, shared), false);
  assert.equal(isFileContentProtected({ status: 'draft' }, shared), false);
  assert.equal(isFileContentProtected({}, shared), false, 'a missing status reads as draft');
});

test('approved refuses content writes in a private workspace too', () => {
  // The badge has to mean one thing. Approved was once Shared-only, so the same
  // file read as frozen or editable depending on which workspace it sat in.
  // Drafting a change is still possible here: `Return to draft` is offered in a
  // private workspace, which the transition test below pins.
  assert.equal(isFileContentProtected({ status: 'approved' }, privateWs), true);
  assert.equal(isFileContentProtected({ status: 'in_review' }, privateWs), false);
  assert.equal(isFileContentProtected({ status: 'draft' }, privateWs), false);
});

test('an inherited published stays writable in a private copy', () => {
  // Not an oversight left behind by the rule above. Sync copies the status but
  // leaves the artifact in the release bucket, so a private row can say
  // `published` while owning nothing, and `allowedTransitionsFor` strips every
  // route out of that state there. Freezing it would leave the file with no
  // writes and no way back.
  assert.equal(isFileContentProtected({ status: 'published' }, privateWs), false);
  assert.deepEqual(allowedTransitionsFor('published', 'owner', false, false), []);
});

test('an approved file in a private workspace still has a way back to draft', () => {
  // What makes freezing `approved` there safe, and the difference from
  // `published`. Asserted so the two cannot be collapsed into one rule later.
  assert.deepEqual(
    allowedTransitionsFor('approved', 'owner', false, false).map((t) => t.toStatus),
    ['in_review', 'draft'],
  );
});
