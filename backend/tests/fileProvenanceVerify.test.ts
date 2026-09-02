import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError } from '../src/errors';
import { FileService } from '../src/services/fileService';
import { computeEventHash } from '../src/services/fileAuditService';

type Row = Record<string, any>;

/** Builds a correctly-linked chain, as the emitter would write it. */
function chain(fileId: number, count: number, workspaceId = 'ws-1'): Row[] {
  let prev: string | null = null;
  return Array.from({ length: count }, (_unused, index) => {
    const seq = index + 1;
    const occurredAt = new Date(Date.UTC(2026, 7, 14, 9, index)).toISOString();
    const payload = { step: index };
    const eventType = index === 0 ? 'file.created' : 'file.content_updated';
    const eventHash = computeEventHash({
      prevEventHash: prev, fileId, seq, eventType, actorUserId: 'u-alice', occurredAt, payload,
    });
    const row: Row = {
      fileId, workspaceId, seq, eventType, actorUserId: 'u-alice',
      payload, prevEventHash: prev, eventHash, occurredAt, sourceFileVersionId: null,
    };
    prev = eventHash;
    return row;
  });
}

function makeService(tables: {
  files?: Row[]; file_audit_events?: Row[]; file_versions?: Row[];
}, opts?: { deny?: boolean }) {
  const db = (name: keyof typeof tables) => {
    let rows = [...(tables[name] ?? [])];
    const api: any = {
      where(clause: Row) {
        rows = rows.filter((r) => Object.entries(clause).every(([k, v]) => r[k] === v));
        return api;
      },
      orderBy(col: string) { rows = [...rows].sort((a, b) => Number(a[col]) - Number(b[col])); return api; },
      async first() { return rows[0]; },
      then(res: any, rej: any) { return Promise.resolve(rows).then(res, rej); },
    };
    return api;
  };
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    db,
    workspaceService: {
      ensureMembership: async () => {
        if (opts?.deny) throw new AccessDeniedError('Not a member');
        return { workspace: {} };
      },
    },
  });
  return service;
}

const FILE = { id: 412, workspaceId: 'ws-1', name: 'q3.md', version: 3 };

test('an intact chain verifies', async () => {
  const service = makeService({ files: [FILE], file_audit_events: chain(412, 4) });
  const result = await service.verifyFileProvenance(412, 'u-alice');

  assert.equal(result.valid, true);
  assert.equal(result.brokenAtSeq, null);
  assert.equal(result.eventCount, 4);
  assert.match(result.chainHead!, /^[0-9a-f]{64}$/);
});

test('an edited event is caught at the right seq', async () => {
  const events = chain(412, 4);
  // Someone rewrites history to hide what a step did.
  events[1].payload = { step: 'tampered' };
  const service = makeService({ files: [FILE], file_audit_events: events });

  const result = await service.verifyFileProvenance(412, 'u-alice');
  assert.equal(result.valid, false);
  assert.equal(result.brokenAtSeq, 2);
});

test('a removed event is caught, because the next one no longer links back', async () => {
  const events = chain(412, 4);
  const withHole = [events[0], events[2], events[3]];
  const service = makeService({ files: [FILE], file_audit_events: withHole });

  const result = await service.verifyFileProvenance(412, 'u-alice');
  assert.equal(result.valid, false);
  assert.equal(result.brokenAtSeq, 3);
});

test('an empty trail is vacuously valid', async () => {
  const service = makeService({ files: [FILE], file_audit_events: [] });
  const result = await service.verifyFileProvenance(412, 'u-alice');
  assert.equal(result.valid, true);
  assert.equal(result.eventCount, 0);
  assert.equal(result.chainHead, null);
});

test('a published file reports both its own chain and the one it inherited', async () => {
  const prior = chain(88, 3, 'ws-priv');
  const current = chain(907, 2, 'ws-team');
  current[0].sourceFileVersionId = 'fv-aaa4';

  const service = makeService({
    files: [{ ...FILE, id: 907, workspaceId: 'ws-team' }],
    file_audit_events: [...prior, ...current],
    file_versions: [{ id: 'fv-aaa4', fileId: 88, version: 3 }],
  });

  const result = await service.verifyFileProvenance(907, 'u-carol');
  assert.equal(result.valid, true);
  assert.equal(result.priorChain?.fileId, 88);
  assert.equal(result.priorChain?.workspaceId, 'ws-priv');
  assert.equal(result.priorChain?.valid, true);
});

test('a break in the inherited half is not reported as intact', async () => {
  // The current chain is fine; the history it rests on is not. Reporting only
  // the near half would give false assurance about the document's origin.
  const prior = chain(88, 3, 'ws-priv');
  prior[1].payload = { step: 'tampered' };
  const current = chain(907, 2, 'ws-team');
  current[0].sourceFileVersionId = 'fv-aaa4';

  const service = makeService({
    files: [{ ...FILE, id: 907, workspaceId: 'ws-team' }],
    file_audit_events: [...prior, ...current],
    file_versions: [{ id: 'fv-aaa4', fileId: 88, version: 3 }],
  });

  const result = await service.verifyFileProvenance(907, 'u-carol');
  assert.equal(result.valid, true, 'this workspace\'s own chain is untouched');
  assert.equal(result.priorChain?.valid, false);
  assert.equal(result.priorChain?.brokenAtSeq, 2);
});

test('verification requires membership', async () => {
  const service = makeService({ files: [FILE], file_audit_events: chain(412, 2) }, { deny: true });
  await assert.rejects(
    () => service.verifyFileProvenance(412, 'u-intruder'),
    (e: unknown) => e instanceof AccessDeniedError,
  );
});
