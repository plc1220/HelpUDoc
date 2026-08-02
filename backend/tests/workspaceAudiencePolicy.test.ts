import assert from 'node:assert/strict';
import test from 'node:test';

import {
  legacyWorkspaceRoleToNamedGrant,
  namedGrantToLegacyWorkspaceRole,
  normalizeSelectedWorkspaceUsers,
} from '../src/services/workspaceAudiencePolicy';

test('selected-person sharing excludes the owner and removes duplicates', () => {
  assert.deepEqual(
    normalizeSelectedWorkspaceUsers('owner-1', ['user-1', 'owner-1', 'user-1', 'user-2']),
    ['user-1', 'user-2'],
  );
});

test('named Publisher remains a direct legacy publishing role', () => {
  assert.equal(namedGrantToLegacyWorkspaceRole('publisher'), 'editor');
  assert.equal(legacyWorkspaceRoleToNamedGrant('editor'), 'publisher');
});

test('legacy roles map to the least-privileged governance grant', () => {
  assert.equal(legacyWorkspaceRoleToNamedGrant('contributor'), 'contributor');
  assert.equal(legacyWorkspaceRoleToNamedGrant('commenter'), 'viewer');
  assert.equal(legacyWorkspaceRoleToNamedGrant('viewer'), 'viewer');
});
