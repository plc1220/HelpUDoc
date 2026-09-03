import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkspaceSubfolderPath } from '../src/utils/workspaceFileTree.ts';

test('joins a name onto its parent folder', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports', '2026'), 'reports/2026');
  assert.equal(buildWorkspaceSubfolderPath('reports/2026', 'q3'), 'reports/2026/q3');
});

test('an empty parent creates at the workspace root', () => {
  // This is the existing root-level "Create folder" action, unchanged.
  assert.equal(buildWorkspaceSubfolderPath('', 'reports'), 'reports');
});

test('keeps slashes in the typed name so deeper paths still work', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports', 'q1/drafts'), 'reports/q1/drafts');
  assert.equal(buildWorkspaceSubfolderPath('', 'a/b/c'), 'a/b/c');
});

test('tolerates stray and repeated separators', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports/', '/2026'), 'reports/2026');
  assert.equal(buildWorkspaceSubfolderPath('reports', '2026//q3'), 'reports/2026/q3');
  assert.equal(buildWorkspaceSubfolderPath('reports', 'archive/'), 'reports/archive');
});

test('normalizes backslashes the same way the rest of the tree does', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports', '2026\\q3'), 'reports/2026/q3');
});

test('refuses an empty result', () => {
  assert.equal(buildWorkspaceSubfolderPath('', ''), null);
  assert.equal(buildWorkspaceSubfolderPath('', '   '), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', ''), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', '/'), null);
});

test('refuses traversal segments', () => {
  // The server refuses these as well; failing here just gives a better message.
  assert.equal(buildWorkspaceSubfolderPath('reports', '..'), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', '../escape'), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', 'a/../../b'), null);
  assert.equal(buildWorkspaceSubfolderPath('..', 'reports'), null);
});

test('a lone dot is not a folder name', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports', '.'), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', './q3'), null);
});

test('a leading dot in a real name is still allowed', () => {
  // `.system` is reserved server-side, but a dotfile-style folder is not invalid.
  assert.equal(buildWorkspaceSubfolderPath('reports', '.drafts'), 'reports/.drafts');
});

test('trims surrounding whitespace but keeps spaces inside a name', () => {
  assert.equal(buildWorkspaceSubfolderPath('reports', '  q3  '), 'reports/q3');
  assert.equal(buildWorkspaceSubfolderPath('reports', 'q3 drafts'), 'reports/q3 drafts');
});

test('refuses a segment that is only whitespace', () => {
  // Otherwise this creates a directory literally named '   '.
  assert.equal(buildWorkspaceSubfolderPath('reports', '  '), null);
  assert.equal(buildWorkspaceSubfolderPath('reports', 'a/ /b'), null);
});
