import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';
import { WorkspacePublicationService } from '../src/services/workspacePublicationService';
import { readPayload, type CapturedAuditEvent } from './helpers/auditHarness';

/**
 * `replaceWorkspaceContent` is the single funnel for publish, sync, restore,
 * apply-review and create-private-copy. Its database writes had no coverage,
 * which matters here because `files.id` is workspace-scoped: content crossing a
 * workspace boundary lands on a *different* row, and the manifest's
 * `fileVersionId` is the only durable link back to the origin.
 */

type Row = Record<string, any>;

function fakeTransaction(
  existingFiles: Row[],
  destinationVisibility: 'private' | 'team' = 'private',
  existingVersions: Row[] = [],
) {
  const audits: CapturedAuditEvent[] = [];
  const fileVersions: Row[] = [];
  const inserted: Row[] = [];
  const updates: Array<{ table: string; where: Row; patch: Row }> = [];
  let nextFileId = 900;

  const builder = (table: string) => {
    const state: { where: Row } = { where: {} };
    const api: any = {
      where(clause: Row) { state.where = { ...state.where, ...clause }; return api; },
      whereNull() { return api; },
      whereIn(_column: string, _values: unknown[]) { return api; },
      // The destination workspace decides whether editorial status is inherited.
      async first() {
        return table === 'workspaces'
          ? { id: 'ws-dest', visibility: destinationVisibility, workspaceType: destinationVisibility }
          : undefined;
      },
      insert(row: Row) {
        let created: Row = row;
        if (table === 'file_audit_events') audits.push(row as CapturedAuditEvent);
        else if (table === 'file_versions') fileVersions.push(row);
        else if (table === 'files') {
          created = { id: nextFileId++, ...row };
          inserted.push(created);
        }
        // Must satisfy both `await insert(...)` and `await insert(...).returning(...)`.
        return {
          returning: async () => [created],
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve([created]).then(resolve, reject),
        } as any;
      },
      update(patch: Row) {
        updates.push({ table, where: state.where, patch });
        const result: any = {
          returning: async () => [{ contentRevision: 12 }],
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ contentRevision: 12 }]).then(resolve),
        };
        return result;
      },
      then(resolve: (rows: Row[]) => unknown, reject: (e: unknown) => unknown) {
        const rows = table === 'files'
          ? existingFiles
          : table === 'file_versions' ? existingVersions : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return api;
  };

  const tx: any = (table: string) => builder(table);
  // knex's insert(...).returning(...) needs to be awaitable in both orders.
  tx.raw = (sql: string, bindings: unknown[] = []) => ({ __raw: sql, bindings });
  tx.fn = { now: () => new Date('2026-08-20T00:00:00.000Z') };
  return { tx, audits, fileVersions, inserted, updates };
}

const makeContent = (name: string, body: string, fileVersionId: string, status?: string) => ({
  files: new Map([[name, {
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(body),
    hash: `sha-${body}`,
    size: Buffer.byteLength(body),
    fileVersionId,
    objectKey: `objects/${name}`,
    objectProvider: 's3',
    providerVersion: 'gen-1',
    ...(status ? { status } : {}),
  }]]),
  folders: [] as string[],
});

async function runSync(
  existingFiles: Row[],
  opts?: {
    destination?: 'private' | 'team';
    incomingStatus?: string;
    body?: string;
    existingVersions?: Row[];
  },
) {
  const workspaceId = `sync-prov-${randomUUID()}`;
  const workspacePath = path.join(resolveWorkspaceRoot(), workspaceId);
  await fs.mkdir(workspacePath, { recursive: true });

  const harness = fakeTransaction(
    existingFiles, opts?.destination ?? 'private', opts?.existingVersions ?? [],
  );
  const service = Object.create(WorkspacePublicationService.prototype) as WorkspacePublicationService;
  Object.assign(service, {
    db: harness.tx,
    objectStore: { provider: 's3' },
  });

  try {
    await (service as any).replaceWorkspaceContent(
      workspaceId,
      makeContent(
        'reports/q3.md',
        opts?.body ?? 'published-body',
        'fv-source-aaa',
        opts?.incomingStatus,
      ),
      'u-carol',
      harness.tx,
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
  return harness;
}

test('content arriving from a publication records the cross-workspace bridge', async () => {
  // Destination workspace has no file at this path, so a brand-new files row is
  // minted — the classic private -> team boundary crossing.
  const { audits } = await runSync([]);

  const synced = audits.find((event) => event.eventType === 'file.synced_from_publication');
  assert.ok(synced, 'expected a file.synced_from_publication event');
  assert.equal(synced.filePath, 'reports/q3.md');
  assert.equal(synced.actorType, 'system');
  assert.equal(synced.actorUserId, 'u-carol');
  // The bridge back to the origin workspace's version row.
  assert.equal(synced.sourceFileVersionId, 'fv-source-aaa');
  assert.equal(synced.sha256, 'sha-published-body');
  assert.equal(synced.seq, 1);
  assert.equal(synced.prevEventHash, null);
  assert.equal(readPayload(synced).createdBySync, true);
});

test('re-syncing an existing path continues that file\'s chain', async () => {
  const { audits } = await runSync([{
    id: 907,
    workspaceId: 'ws-team',
    name: 'reports/q3.md',
    version: 4,
    currentVersionId: 'fv-team-old',
    auditSeq: 5,
    lastAuditHash: 'c'.repeat(64),
  }]);

  const synced = audits.find((event) => event.eventType === 'file.synced_from_publication');
  assert.ok(synced);
  // Same workspace, same path -> same files.id, so the chain must continue
  // rather than restart.
  assert.equal(synced.fileId, 907);
  assert.equal(synced.seq, 6);
  assert.equal(synced.prevEventHash, 'c'.repeat(64));
  assert.equal(readPayload(synced).createdBySync, false);
});

test('a file dropped by an incoming sync is tombstoned, not silently erased', async () => {
  const { audits } = await runSync([{
    id: 908,
    workspaceId: 'ws-team',
    name: 'reports/removed.md',
    version: 2,
    currentVersionId: 'fv-old',
    auditSeq: 1,
    lastAuditHash: 'd'.repeat(64),
  }]);

  const tombstone = audits.find((event) => event.eventType === 'file.tombstoned_by_sync');
  assert.ok(tombstone, 'expected a tombstone event for the removed path');
  assert.equal(tombstone.fileId, 908);
  assert.equal(tombstone.filePath, 'reports/removed.md');
  assert.equal(tombstone.actorType, 'system');
  assert.equal(tombstone.seq, 2);
  assert.equal(readPayload(tombstone).removedBySync, true);
});

// --- editorial status across the workspace boundary --------------------------

/**
 * A file published in the Shared workspace and then synced has *identical*
 * bytes, so it takes the unchanged-content path. That is precisely the path its
 * status has to arrive by, which is easy to miss.
 */
test('a private workspace inherits the Shared status even when the bytes match', async () => {
  const existing = [{
    id: 501,
    name: 'reports/q3.md',
    workspaceId: 'ws-dest',
    version: 3,
    status: 'draft',
    currentVersionId: 'fv-local',
    auditSeq: 4,
    lastAuditHash: 'hash-4',
  }];
  const { audits, updates } = await runSync(existing, {
    destination: 'private',
    incomingStatus: 'published',
    // Same bytes, same name, same type: the unchanged-content path.
    existingVersions: [{
      id: 'fv-local',
      sha256: 'sha-published-body',
      name: 'reports/q3.md',
      mimeType: 'text/markdown',
    }],
  });

  const inherited = audits.find((event) => event.eventType === 'status.inherited');
  assert.ok(inherited, 'expected a status.inherited event');
  assert.equal(readPayload(inherited).fromStatus, 'draft');
  assert.equal(readPayload(inherited).toStatus, 'published');
  assert.equal(inherited.seq, 5, 'continues the existing chain');

  const patch = updates.find((u) => u.table === 'files' && u.patch.status)?.patch;
  assert.equal(patch?.status, 'published');
  // Pinned to *this* workspace's version, not the source's, or the file would
  // report drift that never happened.
  assert.equal(patch?.publishedAtVersion, 3);
  assert.equal(patch?.approvedAtVersion, null);
});

test('status is never carried into the Shared workspace', async () => {
  // The reverse direction would let a private self-approval become a team
  // approval, which is exactly what review exists to prevent.
  const existing = [{
    id: 502,
    name: 'reports/q3.md',
    workspaceId: 'ws-dest',
    version: 3,
    status: 'draft',
    currentVersionId: 'fv-local',
    auditSeq: 4,
    lastAuditHash: 'hash-4',
  }];
  const { audits, updates } = await runSync(existing, {
    destination: 'team',
    incomingStatus: 'approved',
  });

  assert.equal(audits.find((e) => e.eventType === 'status.inherited'), undefined);
  assert.equal(updates.find((u) => u.table === 'files' && u.patch.status), undefined);
});
