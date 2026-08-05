import assert from 'node:assert/strict';
import test from 'node:test';
import knex from 'knex';

import {
  legacyWorkspaceRoleToNamedGrant,
  namedGrantToLegacyWorkspaceRole,
  normalizeSelectedWorkspaceUsers,
} from '../src/services/workspaceAudiencePolicy';
import { buildWorkspaceTeamAccessQuery, strongestWorkspaceRole } from '../src/services/workspaceService';

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

test('workspace team access lookup does not use PostgreSQL reserved aliases', () => {
  const db = knex({ client: 'pg' });
  const sql = buildWorkspaceTeamAccessQuery(db, 'workspace-id', 'team-id').toSQL().sql;

  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.match(sql, /workspaceTeamGrant/);
  void db.destroy();
});

test('effective workspace access keeps the strongest direct or Team role', () => {
  assert.equal(strongestWorkspaceRole('viewer', 'contributor'), 'contributor');
  assert.equal(strongestWorkspaceRole('editor', 'contributor'), 'editor');
  assert.equal(strongestWorkspaceRole('owner', 'viewer'), 'owner');
  assert.equal(strongestWorkspaceRole(undefined, 'viewer'), 'viewer');
});
