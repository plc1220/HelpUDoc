import assert from 'node:assert/strict';
import test from 'node:test';

import { applyFileStatusState, deriveFileStatusChip } from '../src/utils/fileStatusDisplay.ts';
import type { File as WorkspaceFile, FileStatusState } from '../src/types.ts';

const file = (over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  id: '1',
  name: 'report.md',
  workspaceId: 'ws-1',
  version: 4,
  ...over,
} as WorkspaceFile);

const state = (over: Partial<FileStatusState> = {}): FileStatusState => ({
  fileId: 1,
  workspaceId: 'ws-1',
  status: 'approved',
  version: 4,
  drift: false,
  allowedTransitions: [],
  ...over,
});

// These are the assertions from backend/tests/fileStatusService.test.ts, ported
// so the two drift rules cannot move apart. The panes render from the client
// rule, so a disagreement here is a mismatch a user would see.
test('drift is content moving on after a decision', () => {
  assert.equal(deriveFileStatusChip({ status: 'approved', version: 4, approvedAtVersion: 4 }).drift, false);
  assert.equal(deriveFileStatusChip({ status: 'approved', version: 7, approvedAtVersion: 4 }).drift, true);
  assert.equal(deriveFileStatusChip({ status: 'published', version: 2, publishedAtVersion: 1 }).drift, true);
  // Nothing has been decided yet, so nothing can have drifted.
  assert.equal(deriveFileStatusChip({ status: 'draft', version: 9, approvedAtVersion: 1 }).drift, false);
  assert.equal(deriveFileStatusChip({ status: 'in_review', version: 9 }).drift, false);
});

test('an approved file does not drift on the publication pin, nor the reverse', () => {
  assert.equal(deriveFileStatusChip({ status: 'approved', version: 9, publishedAtVersion: 1 }).drift, false);
  assert.equal(deriveFileStatusChip({ status: 'published', version: 9, approvedAtVersion: 1 }).drift, false);
});

test('a row written before the status column existed reads as draft', () => {
  assert.deepEqual(deriveFileStatusChip({ version: 1 }), { status: 'draft', drift: false });
});

test('a transition lands on the file it names, whichever way the id is typed', () => {
  const numericId = applyFileStatusState(file({ id: 1 as unknown as string }), state({ fileId: 1, status: 'in_review' }));
  assert.equal(numericId.status, 'in_review');

  const stringId = applyFileStatusState(file({ id: '1' }), state({ fileId: 1, status: 'in_review' }));
  assert.equal(stringId.status, 'in_review');
});

test('other files are returned untouched, by identity', () => {
  const other = file({ id: '2', status: 'draft' });
  assert.equal(applyFileStatusState(other, state({ fileId: 1, status: 'approved' })), other);
});

test('a status change does not disturb the content or the edit time', () => {
  const before = file({ status: 'draft', content: 'body', name: 'report.md', updatedAt: '2026-01-01T00:00:00Z' });
  const after = applyFileStatusState(before, state({ status: 'approved', version: 4, approvedAtVersion: 4 }));

  assert.equal(after.content, 'body');
  assert.equal(after.name, 'report.md');
  assert.equal(after.updatedAt, '2026-01-01T00:00:00Z');
  assert.equal(after.status, 'approved');
});

test('clearing a pin is carried through rather than left behind', () => {
  const before = file({ status: 'approved', approvedAtVersion: 4 });
  const after = applyFileStatusState(before, state({ status: 'draft', approvedAtVersion: null }));

  assert.equal(after.approvedAtVersion, null);
  assert.equal(deriveFileStatusChip(after).drift, false);
});

// The property the bug was about: after merging the server's answer, what the
// panes render must equal what the server itself said. Both panes derive from
// the merged row, so agreeing with the server is agreeing with each other.
test('the merged row reproduces the status the server reported', () => {
  const cases: FileStatusState[] = [
    state({ status: 'approved', version: 4, approvedAtVersion: 4, drift: false }),
    state({ status: 'approved', version: 7, approvedAtVersion: 4, drift: true }),
    state({ status: 'published', version: 2, publishedAtVersion: 1, drift: true }),
    state({ status: 'draft', version: 9, approvedAtVersion: null, drift: false }),
    state({ status: 'in_review', version: 3, drift: false }),
  ];

  for (const next of cases) {
    const merged = deriveFileStatusChip(applyFileStatusState(file(), next));
    assert.deepEqual(merged, { status: next.status, drift: next.drift }, `for ${next.status}`);
  }
});
