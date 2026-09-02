import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILE_AUDIT_BACKFILL_KEY,
  backfillFileAuditEvents,
  buildBackfillEvents,
  type BackfillVersionRow,
} from '../src/services/fileAuditBackfill';
import { verifyEventChain } from '../src/services/fileProvenance';

const version = (over: Partial<BackfillVersionRow>): BackfillVersionRow => ({
  id: 'fv-1',
  fileId: 412,
  workspaceId: 'ws-1',
  version: 1,
  name: 'reports/q3.md',
  sha256: 'sha-1',
  objectKey: 'ws-1/.system/file-versions/fv-1',
  sizeBytes: 100,
  changeKind: 'create',
  createdBy: 'u-alice',
  createdAt: new Date('2026-08-14T09:00:00.000Z'),
  ...over,
});

let counter = 0;
const makeId = () => `ev-${++counter}`;

test('a reconstructed trail is a valid hash chain', () => {
  counter = 0;
  const { events, lastHash } = buildBackfillEvents([
    version({ id: 'fv-1', version: 1, changeKind: 'create' }),
    version({ id: 'fv-2', version: 2, changeKind: 'content' }),
    version({ id: 'fv-3', version: 3, changeKind: 'artifact', sourceRunId: 'run-9' }),
  ], makeId);

  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(events[0].prevEventHash, null);
  assert.equal(events[1].prevEventHash, events[0].eventHash);
  assert.equal(lastHash, events[2].eventHash);

  // The reconstructed chain must verify exactly like a natively-written one,
  // or /provenance/verify would report every legacy file as tampered.
  const asRows = events.map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
  assert.deepEqual(verifyEventChain(asRows as any), { verified: true, brokenAtSeq: null });
});

test('versions are ordered by version number, not by arrival order', () => {
  counter = 0;
  const { events } = buildBackfillEvents([
    version({ id: 'fv-3', version: 3 }),
    version({ id: 'fv-1', version: 1 }),
    version({ id: 'fv-2', version: 2 }),
  ], makeId);

  assert.deepEqual(events.map((event) => event.fileVersionId), ['fv-1', 'fv-2', 'fv-3']);
  assert.deepEqual(events.map((event) => event.fileVersion), [1, 2, 3]);
});

test('historical change kinds and agent attribution are preserved', () => {
  counter = 0;
  const { events } = buildBackfillEvents([
    version({ id: 'fv-1', version: 1, changeKind: 'create' }),
    version({ id: 'fv-2', version: 2, changeKind: 'artifact', sourceRunId: 'run-9' }),
    version({ id: 'fv-3', version: 3, changeKind: 'rename' }),
    version({ id: 'fv-4', version: 4, changeKind: 'delete' }),
  ], makeId);

  assert.deepEqual(events.map((event) => event.eventType), [
    'file.created', 'file.agent_generated', 'file.renamed', 'file.deleted',
  ]);
  assert.deepEqual(events.map((event) => event.actorType), [
    'human', 'agent', 'human', 'human',
  ]);
  assert.equal(events[1].runId, 'run-9');
});

test('reconstructed events are marked as backfilled', () => {
  counter = 0;
  const { events } = buildBackfillEvents([version({})], makeId);
  // Prompts and knowledge refs cannot be recovered for historical runs, so a
  // reader must be able to tell reconstructed history from recorded history.
  assert.equal(JSON.parse(events[0].payload).backfilled, true);
});

// --- integration-shaped: exercise the migration guard ---

function fakeDb(state: {
  migrations: Array<{ key: string }>;
  versions: BackfillVersionRow[];
  audits: Array<{ fileId: number }>;
  files: Array<Record<string, unknown>>;
}) {
  const db: any = (table: string) => {
    let rows: any[] = table === 'application_migrations' ? state.migrations
      : table === 'file_versions' ? state.versions
        : table === 'file_audit_events' ? state.audits
          : state.files;
    const api: any = {
      where(clause: any) {
        rows = rows.filter((row) => Object.entries(clause)
          .every(([key, value]) => row[key] === value));
        return api;
      },
      whereIn(column: string, values: unknown[]) {
        rows = rows.filter((row) => values.includes(row[column]));
        return api;
      },
      distinct(column: string) {
        const seen = new Set<unknown>();
        rows = rows.filter((row) => {
          if (seen.has(row[column])) return false;
          seen.add(row[column]);
          return true;
        }).map((row) => ({ [column]: row[column] }));
        return api;
      },
      orderBy() { return api; },
      async first() { return rows[0]; },
      insert(payload: any) {
        const list = Array.isArray(payload) ? payload : [payload];
        if (table === 'file_audit_events') state.audits.push(...list);
        if (table === 'application_migrations') state.migrations.push(...list);
        const chain: any = {
          onConflict: () => ({ ignore: async () => undefined }),
          then: (resolve: any) => Promise.resolve(list).then(resolve),
        };
        return chain;
      },
      update: async () => 1,
      then(resolve: any, reject: any) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return api;
  };
  db.transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  return db;
}

test('the backfill writes once and is a no-op on re-run', async () => {
  counter = 0;
  const state = {
    migrations: [] as Array<{ key: string }>,
    versions: [
      version({ id: 'fv-1', fileId: 412, version: 1 }),
      version({ id: 'fv-2', fileId: 412, version: 2, changeKind: 'content' }),
    ],
    audits: [] as Array<{ fileId: number }>,
    files: [{ id: 412 }],
  };
  const db = fakeDb(state);

  const first = await backfillFileAuditEvents(db, { makeId });
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.filesProcessed, 1);
  assert.equal(first.eventsWritten, 2);
  assert.equal(state.audits.length, 2);
  assert.ok(state.migrations.some((row) => row.key === FILE_AUDIT_BACKFILL_KEY));

  // Re-running must not duplicate the trail.
  const second = await backfillFileAuditEvents(db, { makeId });
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.eventsWritten, 0);
  assert.equal(state.audits.length, 2, 'a second run must not append events');
});

test('files that already have a trail are skipped, so a partial run can resume', async () => {
  counter = 0;
  const state = {
    migrations: [] as Array<{ key: string }>,
    versions: [
      version({ id: 'fv-1', fileId: 412, version: 1 }),
      version({ id: 'fv-9', fileId: 500, version: 1 }),
    ],
    // File 412 was already backfilled before the run was interrupted.
    audits: [{ fileId: 412 }] as Array<{ fileId: number }>,
    files: [{ id: 412 }, { id: 500 }],
  };
  const db = fakeDb(state);

  const result = await backfillFileAuditEvents(db, { makeId });
  assert.equal(result.filesSkipped, 1);
  assert.equal(result.filesProcessed, 1);
  assert.equal(result.eventsWritten, 1);
});
