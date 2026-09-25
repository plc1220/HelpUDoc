import assert from 'node:assert/strict';
import test from 'node:test';

import { FileService } from '../src/services/fileService';
import { createAuditCapture, readPayload } from './helpers/auditHarness';

/**
 * Every durable mutation in FileService funnels through `emitVersionEvent`, so
 * exercising it directly covers all six wired insert sites.
 */
const emit = async (args: Record<string, unknown>) => {
  const { tx, events } = createAuditCapture();
  const service = Object.create(FileService.prototype) as FileService;
  await (service as any).emitVersionEvent(tx, args);
  return events[0];
};

const lockedFile = (overrides: Record<string, unknown> = {}) => ({
  id: 412,
  workspaceId: 'ws-1',
  name: 'reports/q3.md',
  auditSeq: 3,
  lastAuditHash: 'a'.repeat(64),
  ...overrides,
});

test('rename and move are recorded as distinct event types', async () => {
  const renamed = await emit({
    file: lockedFile(),
    filePath: 'reports/q3-final.md',
    changeKind: 'rename',
    versionId: 'fv-2',
    version: 4,
    userId: 'u-alice',
    payload: { previousPath: 'reports/q3.md', newPath: 'reports/q3-final.md' },
  });
  const moved = await emit({
    file: lockedFile(),
    filePath: 'archive/q3.md',
    changeKind: 'move',
    versionId: 'fv-3',
    version: 4,
    userId: 'u-alice',
    payload: { previousPath: 'reports/q3.md', newPath: 'archive/q3.md' },
  });

  assert.equal(renamed.eventType, 'file.renamed');
  assert.equal(moved.eventType, 'file.moved');
  // The trail records where it went, not just that it moved.
  assert.equal(readPayload(renamed).newPath, 'reports/q3-final.md');
  assert.equal(readPayload(moved).previousPath, 'reports/q3.md');
});

test('a soft delete still appends an event rather than erasing the trail', async () => {
  const event = await emit({
    file: lockedFile(),
    filePath: 'reports/q3.md',
    changeKind: 'delete',
    versionId: 'fv-9',
    version: 4,
    userId: 'u-bob',
    payload: { softDelete: true },
  });

  assert.equal(event.eventType, 'file.deleted');
  assert.equal(event.actorUserId, 'u-bob');
  assert.equal(readPayload(event).softDelete, true);
});

test('agent-written artifacts are attributed to the agent but keep the human actor', async () => {
  const event = await emit({
    file: lockedFile(),
    filePath: 'reports/q3.md',
    changeKind: 'artifact',
    versionId: 'fv-4',
    version: 4,
    userId: 'u-alice',
    sourceRunId: 'run-88f2',
    payload: {},
  });

  assert.equal(event.eventType, 'file.agent_generated');
  assert.equal(event.actorType, 'agent');
  // There is no separate agent identity: the run's owner remains the actor.
  assert.equal(event.actorUserId, 'u-alice');
  assert.equal(event.runId, 'run-88f2');
});

test('seq and the hash chain continue from the locked files row', async () => {
  const event = await emit({
    file: lockedFile({ auditSeq: 7, lastAuditHash: 'b'.repeat(64) }),
    filePath: 'reports/q3.md',
    changeKind: 'content',
    versionId: 'fv-5',
    version: 8,
    userId: 'u-alice',
    payload: {},
  });

  assert.equal(event.seq, 8);
  assert.equal(event.prevEventHash, 'b'.repeat(64));
  assert.equal(event.fileVersion, 8);
  assert.equal(event.fileVersionId, 'fv-5');
});

test('a brand-new file starts the chain at seq 1 with no predecessor', async () => {
  const event = await emit({
    file: lockedFile({ auditSeq: 0, lastAuditHash: null }),
    filePath: 'reports/new.md',
    changeKind: 'create',
    versionId: 'fv-1',
    version: 1,
    userId: 'u-alice',
    payload: {},
  });

  assert.equal(event.seq, 1);
  assert.equal(event.prevEventHash, null);
  assert.equal(event.eventType, 'file.created');
});

test('a freeflow clobber is recorded prominently', async () => {
  // Team workspaces on the "direct" editing policy skip version-conflict
  // checks, so one save can land on top of another. The trail must say so.
  const event = await emit({
    file: lockedFile(),
    filePath: 'reports/q3.md',
    changeKind: 'content',
    versionId: 'fv-6',
    version: 4,
    userId: 'u-dave',
    payload: { staleOverwrite: true, baseVersion: 3 },
  });

  assert.equal(readPayload(event).staleOverwrite, true);
});
