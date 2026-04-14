import assert from 'node:assert/strict';
import path from 'path';

import { REPO_ROOT, getWorkspaceRootDiagnostic, resolveWorkspaceRoot } from '../src/config/workspaceRoot';

const expected = path.join(REPO_ROOT, 'backend', 'workspaces');

assert.equal(
  resolveWorkspaceRoot('backend/workspaces'),
  expected,
  'backend/workspaces should resolve from repo root',
);

const diagnostic = getWorkspaceRootDiagnostic('backend/workspaces');
assert.equal(diagnostic.resolvedPath, expected);
assert.equal(diagnostic.source, 'env');

const defaultDiagnostic = getWorkspaceRootDiagnostic('');
assert.equal(defaultDiagnostic.resolvedPath, expected);
assert.equal(defaultDiagnostic.source, 'default');

console.log('workspace root resolution ok');
