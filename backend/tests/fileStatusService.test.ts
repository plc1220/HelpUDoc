import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError, ConflictError, NotFoundError } from '../src/errors';
import {
  approveFilesOnProposalAccepted,
  FileStatusService,
  allowedTransitionsFor,
  hasDrifted,
  normalizeFileStatus,
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
  assert.equal(menu[0].requiresReason, true);
  assert.equal(menu[0].isRevert, true);
});

test('reverts are flagged and require a reason; forward moves do not', () => {
  const submit = allowedTransitionsFor('draft', 'editor', false, true)[0];
  assert.equal(submit.isRevert, false);
  assert.equal(submit.requiresReason, false);

  // From approved there is one forward move (publish) and the rest go back.
  for (const t of allowedTransitionsFor('approved', 'editor', false, true)) {
    if (t.toStatus === 'published') {
      assert.equal(t.isRevert, false, 'publishing moves the file forward');
      assert.equal(t.requiresReason, false);
      continue;
    }
    assert.equal(t.isRevert, true, `${t.toStatus} must be marked a revert`);
    assert.equal(t.requiresReason, true, `${t.toStatus} must require a reason`);
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
    allowedTransitionsFor('draft', 'owner', false, false).map((t) => t.toStatus),
    ['in_review'],
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
  // Skipping review entirely would defeat the point of the workflow.
  const { service } = makeService(baseFile({ status: 'draft' }), 'owner');
  await assert.rejects(
    () => service.transition(412, 'u-bob', { toStatus: 'approved' }),
    (e: unknown) => e instanceof ConflictError && /Cannot move a file from draft to approved/.test((e as Error).message),
  );
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

test('you cannot approve a file you last edited', async () => {
  const { service } = makeService(
    baseFile({ status: 'in_review', updatedBy: 'u-editor' }), 'editor',
  );
  await assert.rejects(
    () => service.transition(412, 'u-editor', { toStatus: 'approved' }),
    (e: unknown) => e instanceof AccessDeniedError && /you last edited/.test((e as Error).message),
  );
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

test('a revert requires a reason and records the version it applied to', async () => {
  const { service, auditEvents, governanceEvents, files } = makeService(
    baseFile({ status: 'approved', version: 7, approvedAtVersion: 4 }), 'editor',
  );

  await assert.rejects(
    () => service.transition(412, 'u-bob', { toStatus: 'draft' }),
    (e: unknown) => e instanceof ConflictError && /reason is required/.test((e as Error).message),
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
