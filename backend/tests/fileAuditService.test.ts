import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeEventHash,
  eventTypeForChangeKind,
  nextAuditSeq,
  recordFileEvent,
  resolveActorType,
} from '../src/services/fileAuditService';
import { createAuditCapture, readPayload } from './helpers/auditHarness';

const baseInput = {
  fileId: 412,
  workspaceId: 'ws-1',
  filePath: 'reports/q3.md',
  eventType: 'file.created' as const,
  seq: 1,
  actorUserId: 'u-alice',
  occurredAt: new Date('2026-08-14T09:12:04.000Z'),
};

test('recordFileEvent writes a denormalized row with a hash', async () => {
  const { tx, events } = createAuditCapture();
  const result = await recordFileEvent(tx, {
    ...baseInput,
    sha256: 'a1b2',
    objectKey: 'ws-1/.system/file-versions/fv-1',
    fileVersionId: 'fv-1',
    fileVersion: 1,
    payload: { sizeBytes: 20481 },
  });

  assert.equal(events.length, 1);
  const [row] = events;
  assert.equal(row.fileId, 412);
  assert.equal(row.workspaceId, 'ws-1');
  assert.equal(row.filePath, 'reports/q3.md');
  assert.equal(row.seq, 1);
  assert.equal(row.eventType, 'file.created');
  assert.equal(row.actorType, 'human');
  assert.equal(row.prevEventHash, null);
  assert.equal(row.eventHash, result.eventHash);
  assert.match(row.eventHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(readPayload(row), { sizeBytes: 20481 });
});

test('array-valued payloads survive the jsonb encoding gotcha', async () => {
  // A raw JS array handed to the pg driver becomes a Postgres array literal and
  // is rejected as invalid json. jsonbParam must add the explicit ::jsonb cast.
  const { tx, events } = createAuditCapture();
  await recordFileEvent(tx, {
    ...baseInput,
    payload: { skillsInvoked: ['research', 'data'], chunks: [{ page: 14 }] },
  });

  const encoded = events[0].payload as { __raw: string; bindings: unknown[] };
  assert.match(encoded.__raw, /::jsonb/);
  assert.deepEqual(readPayload(events[0]), {
    skillsInvoked: ['research', 'data'],
    chunks: [{ page: 14 }],
  });
});

test('the hash chain links events and detects payload tampering', () => {
  const first = computeEventHash({
    prevEventHash: null,
    fileId: 412,
    seq: 1,
    eventType: 'file.created',
    actorUserId: 'u-alice',
    occurredAt: baseInput.occurredAt,
    payload: { sizeBytes: 1 },
  });
  const second = computeEventHash({
    prevEventHash: first,
    fileId: 412,
    seq: 2,
    eventType: 'file.content_updated',
    actorUserId: 'u-alice',
    occurredAt: baseInput.occurredAt,
    payload: { sizeBytes: 2 },
  });

  assert.notEqual(first, second);

  // Re-deriving the same event reproduces the hash exactly.
  assert.equal(second, computeEventHash({
    prevEventHash: first,
    fileId: 412,
    seq: 2,
    eventType: 'file.content_updated',
    actorUserId: 'u-alice',
    occurredAt: baseInput.occurredAt,
    payload: { sizeBytes: 2 },
  }));

  // Mutating the payload breaks it.
  assert.notEqual(second, computeEventHash({
    prevEventHash: first,
    fileId: 412,
    seq: 2,
    eventType: 'file.content_updated',
    actorUserId: 'u-alice',
    occurredAt: baseInput.occurredAt,
    payload: { sizeBytes: 999 },
  }));

  // Re-pointing at a different predecessor breaks it too, so a removed event
  // cannot be hidden by rewriting the rows around it.
  assert.notEqual(second, computeEventHash({
    prevEventHash: 'deadbeef',
    fileId: 412,
    seq: 2,
    eventType: 'file.content_updated',
    actorUserId: 'u-alice',
    occurredAt: baseInput.occurredAt,
    payload: { sizeBytes: 2 },
  }));
});

test('hashing is order-independent for payload keys', () => {
  const left = computeEventHash({ ...baseInput, payload: { a: 1, b: [2, 3] } });
  const right = computeEventHash({ ...baseInput, payload: { b: [2, 3], a: 1 } });
  assert.equal(left, right);
});

test('nextAuditSeq counts from the locked files row', () => {
  assert.equal(nextAuditSeq({ auditSeq: 0 }), 1);
  assert.equal(nextAuditSeq({ auditSeq: 7 }), 8);
  // A row created before the column existed backfills to 0.
  assert.equal(nextAuditSeq({ auditSeq: null }), 1);
  assert.equal(nextAuditSeq({} as { auditSeq?: number }), 1);
});

test('changeKind maps onto the event taxonomy', () => {
  assert.equal(eventTypeForChangeKind('create'), 'file.created');
  assert.equal(eventTypeForChangeKind('content'), 'file.content_updated');
  assert.equal(eventTypeForChangeKind('artifact'), 'file.agent_generated');
  assert.equal(eventTypeForChangeKind('rename'), 'file.renamed');
  assert.equal(eventTypeForChangeKind('move'), 'file.moved');
  assert.equal(eventTypeForChangeKind('restore'), 'file.restored');
  assert.equal(eventTypeForChangeKind('delete'), 'file.deleted');
});

test('agent attribution requires both an artifact commit and a run id', () => {
  // The acting user stays the human who started the run; actorType is what
  // distinguishes agent-authored content.
  assert.equal(resolveActorType('artifact', 'run-1'), 'agent');
  assert.equal(resolveActorType('artifact', null), 'human');
  assert.equal(resolveActorType('content', 'run-1'), 'human');
  assert.equal(resolveActorType('create', undefined), 'human');
});

test('internal workspace storage is never audited', async () => {
  // `.system/` holds immutable version blobs, upload staging and the OKF
  // knowledge bundles a single ingested document explodes into; `sandbox-runs/`
  // is per-run agent scratch. None are user documents, and on a real workspace
  // they outnumbered real files ~70:1 before this exclusion existed.
  const { tx, events } = createAuditCapture();

  for (const filePath of [
    '.system/knowledge/5/bundles/abc/concepts/person/someone.md',
    '.system/file-versions/fv-1',
    'sandbox-runs/run-1/scratch.png',
    'nested/.system/thing.md',
  ]) {
    const result = await recordFileEvent(tx, { ...baseInput, filePath });
    assert.equal(result, null, `${filePath} must not be audited`);
  }
  assert.equal(events.length, 0);
});

test('ordinary documents are still audited, including lookalike names', async () => {
  const { tx, events } = createAuditCapture();

  for (const filePath of [
    'reports/q3.md',
    'system/notes.md',          // no leading dot -> a real folder
    'my.system.notes.md',       // substring, not a path segment
    'sandbox-runs-summary.md',  // prefix, not a path segment
  ]) {
    const result = await recordFileEvent(tx, { ...baseInput, filePath });
    assert.notEqual(result, null, `${filePath} must be audited`);
  }
  assert.equal(events.length, 4);
});

test('empty-string ids are stored as null, not rejected by Postgres', async () => {
  // The run pipeline hands optional ids through as '' rather than undefined.
  // uuid columns reject '', and `?? null` does not catch it — this previously
  // failed the artifact commit and took the whole agent run down with it.
  const { tx, events } = createAuditCapture();
  await recordFileEvent(tx, {
    ...baseInput,
    actorUserId: '',
    conversationId: '',
    turnId: '',
    runId: '',
    fileVersionId: '',
    sourceFileVersionId: '',
    langfuseTraceId: '',
  });

  const [row] = events;
  for (const field of [
    'actorUserId', 'conversationId', 'turnId', 'runId',
    'fileVersionId', 'sourceFileVersionId', 'langfuseTraceId',
  ] as const) {
    assert.equal((row as any)[field], null, `${field} must be null, not ''`);
  }
});

test('whitespace-only ids are treated as absent too', async () => {
  const { tx, events } = createAuditCapture();
  await recordFileEvent(tx, { ...baseInput, conversationId: '   ', runId: '\t' });
  assert.equal(events[0].conversationId, null);
  assert.equal(events[0].runId, null);
});

test('real ids still survive normalization', async () => {
  const { tx, events } = createAuditCapture();
  await recordFileEvent(tx, {
    ...baseInput,
    actorUserId: 'eaae7fb2-7915-4e6b-a66e-0b35b189dbaf',
    runId: 'run-88f2',
  });
  assert.equal(events[0].actorUserId, 'eaae7fb2-7915-4e6b-a66e-0b35b189dbaf');
  assert.equal(events[0].runId, 'run-88f2');
});
