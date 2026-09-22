/**
 * What the user is told after a sync rewrites their draft.
 *
 * Autosync runs when a draft is opened and used to say nothing at all, so an
 * incoming change looked exactly like the user's own work disappearing. These
 * cover the wording both sync paths now share.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSyncSummary, describeSyncedFiles } from '../src/utils/workspaceDraftSync.ts';

test('names every file when there are few', () => {
  assert.equal(describeSyncedFiles(['a.md']), 'a.md');
  assert.equal(describeSyncedFiles(['a.md', 'b.md', 'c.md']), 'a.md, b.md, c.md');
});

test('caps the list once it stops being readable', () => {
  assert.equal(
    describeSyncedFiles(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']),
    'a.md, b.md, c.md and 2 more',
  );
});

test('an absent or empty list describes nothing', () => {
  assert.equal(describeSyncedFiles(undefined), '');
  assert.equal(describeSyncedFiles([]), '');
  assert.equal(describeSyncedFiles(['', null as unknown as string]), '');
});

test('the summary counts and agrees in number', () => {
  assert.equal(
    buildSyncSummary('My draft', ['report.md']),
    'Synced 1 file from the Shared workspace into My draft: report.md.',
  );
  assert.equal(
    buildSyncSummary('My draft', ['a.md', 'b.md']),
    'Synced 2 files from the Shared workspace into My draft: a.md, b.md.',
  );
});

test('falls back when the backend reported no file list', () => {
  // An older backend does not send `syncedFiles`, and the detached and
  // no-base paths have nothing to diff. The user must still be told a sync
  // happened rather than seeing a message about zero files.
  assert.equal(
    buildSyncSummary('My draft', undefined),
    'Synced the latest Shared Working version into My draft.',
  );
  assert.equal(
    buildSyncSummary('My draft', []),
    'Synced the latest Shared Working version into My draft.',
  );
});
