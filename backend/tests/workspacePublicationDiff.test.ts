import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findPublicationConflicts,
  hasFileChanged,
  mergePublicationFolders,
} from '../src/services/workspacePublicationDiff';

const state = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([filePath, hash]) => [filePath, { hash }]));

test('hasFileChanged detects additions, edits, and deletions', () => {
  assert.equal(hasFileChanged(undefined, { hash: 'a' }), true);
  assert.equal(hasFileChanged({ hash: 'a' }, { hash: 'b' }), true);
  assert.equal(hasFileChanged({ hash: 'a' }, undefined), true);
  assert.equal(hasFileChanged({ hash: 'a' }, { hash: 'a' }), false);
  assert.equal(hasFileChanged(undefined, undefined), false);
});

test('different files can change without creating a conflict', () => {
  const conflicts = findPublicationConflicts(
    state({ 'brief.md': 'brief-1', 'data.csv': 'data-1' }),
    state({ 'brief.md': 'brief-2', 'data.csv': 'data-1' }),
    state({ 'brief.md': 'brief-1', 'data.csv': 'data-2' }),
  );
  assert.deepEqual(conflicts, []);
});

test('the same resulting content is not a conflict', () => {
  const conflicts = findPublicationConflicts(
    state({ 'brief.md': 'brief-1' }),
    state({ 'brief.md': 'brief-2' }),
    state({ 'brief.md': 'brief-2' }),
  );
  assert.deepEqual(conflicts, []);
});

test('overlapping edits and delete-versus-edit changes require review', () => {
  const conflicts = findPublicationConflicts(
    state({ 'brief.md': 'brief-1', 'old.md': 'old-1' }),
    state({ 'brief.md': 'brief-private' }),
    state({ 'brief.md': 'brief-team', 'old.md': 'old-team' }),
  );

  assert.deepEqual(conflicts, [
    {
      path: 'brief.md',
      privateChange: 'changed',
      teamChange: 'changed',
    },
    {
      path: 'old.md',
      privateChange: 'deleted',
      teamChange: 'changed',
    },
  ]);
});

test('conflicts are returned in stable path order', () => {
  const conflicts = findPublicationConflicts(
    state({ 'z.md': '1', 'a.md': '1' }),
    state({ 'z.md': '2', 'a.md': '2' }),
    state({ 'z.md': '3', 'a.md': '3' }),
  );

  assert.deepEqual(conflicts.map((conflict) => conflict.path), ['a.md', 'z.md']);
});

test('folder merge preserves one-sided additions and deletions', () => {
  assert.deepEqual(
    mergePublicationFolders(
      ['deleted-privately', 'deleted-by-team', 'unchanged'],
      ['deleted-by-team', 'unchanged', 'private-added'],
      ['deleted-privately', 'unchanged', 'team-added'],
    ),
    ['private-added', 'team-added', 'unchanged'],
  );
});

test('folder merge includes parent folders required by selected files', () => {
  assert.deepEqual(
    mergePublicationFolders(['reports'], [], ['reports'], ['reports/2026/summary.md']),
    ['reports', 'reports/2026'],
  );
});
