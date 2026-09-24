import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError } from '../src/errors';
import { FileService } from '../src/services/fileService';
import { computeEventHash } from '../src/services/fileAuditService';

type Row = Record<string, any>;

interface Tables {
  files?: Row[];
  file_audit_events?: Row[];
  file_versions?: Row[];
  users?: Row[];
}

/** Minimal knex-alike over in-memory tables, honouring the filters we use. */
function fakeDb(tables: Tables) {
  return (table: keyof Tables) => {
    const rows = [...(tables[table] ?? [])];
    let filtered = rows;
    const api: any = {
      where(clause: Row) {
        filtered = filtered.filter((row) =>
          Object.entries(clause).every(([key, value]) => row[key] === value));
        return api;
      },
      andWhere(column: string, operator: string, value: number) {
        filtered = filtered.filter((row) => (
          operator === '>' ? Number(row[column]) > value : Number(row[column]) <= value
        ));
        return api;
      },
      whereNull(column: string) {
        filtered = filtered.filter((row) => row[column] == null);
        return api;
      },
      whereIn(column: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[column]));
        return api;
      },
      select() { return api; },
      orderBy(column: string) {
        filtered = [...filtered].sort((a, b) => Number(a[column]) - Number(b[column]));
        return api;
      },
      limit(count: number) {
        filtered = filtered.slice(0, count);
        return api;
      },
      async first() { return filtered[0]; },
      then(resolve: (r: Row[]) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve(filtered).then(resolve, reject);
      },
    };
    return api;
  };
}

function makeService(tables: Tables, opts?: { denyMembership?: boolean }) {
  const service = Object.create(FileService.prototype) as FileService;
  const membershipChecks: string[] = [];
  Object.assign(service, {
    db: fakeDb(tables),
    workspaceService: {
      ensureMembership: async (workspaceId: string) => {
        membershipChecks.push(workspaceId);
        if (opts?.denyMembership) throw new AccessDeniedError('Not a member');
        return { workspace: { id: workspaceId } };
      },
    },
  });
  return { service, membershipChecks };
}

const auditRow = (over: Row = {}): Row => {
  const base = {
    id: 'ev-1',
    fileId: 412,
    workspaceId: 'ws-1',
    filePath: 'reports/q3.md',
    seq: 1,
    eventType: 'file.created',
    actorUserId: 'u-alice',
    actorType: 'human',
    payload: {},
    prevEventHash: null,
    occurredAt: '2026-08-14T09:00:00.000Z',
    sourceFileVersionId: null,
    ...over,
  };
  return { ...base, eventHash: computeEventHash(base as any) };
};

const FILE = {
  id: 412, workspaceId: 'ws-1', name: 'reports/q3.md', version: 4,
  createdAt: '2026-08-14T09:00:00.000Z', deletedAt: null,
};

test('provenance requires workspace membership', async () => {
  const { service, membershipChecks } = makeService(
    { files: [FILE], file_audit_events: [auditRow()] },
    { denyMembership: true },
  );

  await assert.rejects(
    () => service.getFileProvenance(412, 'u-intruder'),
    (error: unknown) => error instanceof AccessDeniedError,
  );
  // Membership is checked on the file's own workspace, not a caller-supplied one.
  assert.deepEqual(membershipChecks, ['ws-1']);
});

test('a file with no recorded events still returns a document', async () => {
  const { service } = makeService({ files: [FILE], file_audit_events: [] });
  const doc = await service.getFileProvenance(412, 'u-alice');

  assert.equal(doc.file.id, 412);
  assert.equal(doc.file.name, 'reports/q3.md');
  assert.deepEqual(doc.events, []);
  assert.equal(doc.origin.kind, 'unknown');
  assert.equal(doc.integrity.eventCount, 0);
});

test('a missing file is a 404, not an empty document', async () => {
  const { service } = makeService({ files: [], file_audit_events: [] });
  await assert.rejects(() => service.getFileProvenance(999, 'u-alice'), /File not found/);
});

test('actor display names are resolved from the users table', async () => {
  const { service } = makeService({
    files: [FILE],
    file_audit_events: [auditRow()],
    users: [{ id: 'u-alice', displayName: 'Alice Tan' }],
  });
  const doc = await service.getFileProvenance(412, 'u-alice');
  assert.equal(doc.events[0].actor?.displayName, 'Alice Tan');
});

test('the bridge pulls in prior-workspace history up to the published version', async () => {
  const priorRows = [
    auditRow({ id: 'p1', fileId: 88, workspaceId: 'ws-priv', seq: 1 }),
    auditRow({
      id: 'p2', fileId: 88, workspaceId: 'ws-priv', seq: 2,
      eventType: 'file.agent_generated', fileVersionId: 'fv-aaa4',
    }),
    // Work the origin workspace did *after* publishing must not leak in.
    auditRow({ id: 'p3', fileId: 88, workspaceId: 'ws-priv', seq: 3, eventType: 'file.content_updated' }),
  ];
  const { service } = makeService({
    files: [{ ...FILE, id: 907, workspaceId: 'ws-team' }],
    file_audit_events: [
      ...priorRows,
      auditRow({
        id: 'c1', fileId: 907, workspaceId: 'ws-team', seq: 1,
        eventType: 'file.synced_from_publication', sourceFileVersionId: 'fv-aaa4',
      }),
    ],
    file_versions: [{ id: 'fv-aaa4', fileId: 88, version: 2 }],
  });

  const doc = await service.getFileProvenance(907, 'u-carol');

  assert.equal(doc.origin.priorWorkspace?.bridgeVersionId, 'fv-aaa4');
  assert.equal(doc.origin.priorWorkspace?.eventCount, 2, 'post-publication work must be excluded');
  assert.deepEqual(doc.events.map((event) => event.chain), ['prior', 'prior', 'current']);
});

test('audit events paginate and report a cursor only when more remain', async () => {
  const events = Array.from({ length: 5 }, (_unused, index) =>
    auditRow({ id: `ev-${index + 1}`, seq: index + 1 }));
  const { service } = makeService({ files: [FILE], file_audit_events: events });

  const firstPage = await service.getFileAuditEvents(412, 'u-alice', { limit: 2 });
  assert.equal(firstPage.events.length, 2);
  assert.deepEqual(firstPage.events.map((e: any) => e.seq), [1, 2]);
  assert.equal(firstPage.nextCursor, 2);

  const lastPage = await service.getFileAuditEvents(412, 'u-alice', { cursor: 3, limit: 10 });
  assert.deepEqual(lastPage.events.map((e: any) => e.seq), [4, 5]);
  assert.equal(lastPage.nextCursor, null, 'no cursor once the trail is exhausted');
});

test('audit event listing also enforces membership', async () => {
  const { service } = makeService(
    { files: [FILE], file_audit_events: [auditRow()] },
    { denyMembership: true },
  );
  await assert.rejects(
    () => service.getFileAuditEvents(412, 'u-intruder'),
    (error: unknown) => error instanceof AccessDeniedError,
  );
});
