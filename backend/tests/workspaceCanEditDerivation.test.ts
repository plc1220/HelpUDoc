/**
 * `resolveWorkspaceContentEditAccess` is the single definition of "may this
 * member change workspace content", and it exists because three call sites
 * answered that question independently and disagreed: `listWorkspacesForUser`
 * ignored `editingPolicy` altogether, so a Review-mode contributor was handed an
 * editable canvas and then refused on save.
 *
 * This table is the anti-drift test. If someone re-inlines the rule at one of
 * those call sites, the divergence shows up here rather than in production.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEAM_GRANT_ROLES,
  isWorkspaceContentLocked,
  resolveWorkspaceContentEditAccess,
  strongestWorkspaceRole,
} from '../src/services/workspaceService';

type Role = 'owner' | 'editor' | 'contributor' | 'viewer';

const resolve = (overrides: {
  isShared?: boolean;
  status?: 'active' | 'trashed' | 'purged';
  role?: Role;
  editingPolicy?: 'direct' | 'review' | null;
  contentLocked?: boolean;
} = {}) => resolveWorkspaceContentEditAccess({
  isShared: true,
  status: 'active',
  role: 'contributor',
  editingPolicy: 'direct',
  contentLocked: false,
  ...overrides,
});

// ─── The lock predicate ──────────────────────────────────────────────────────

test('only a Shared workspace holding a current version counts as locked', () => {
  assert.equal(isWorkspaceContentLocked({
    visibility: 'team', workspaceType: 'team', currentPublishedVersionId: 'v1',
  }), true);
  assert.equal(isWorkspaceContentLocked({
    visibility: 'team', workspaceType: 'team', currentPublishedVersionId: null,
  }), false);
});

test('a private workspace is never locked, even carrying a stale version id', () => {
  // Version history belongs to the Shared workspace. A private copy that somehow
  // holds the column must not become read-only from it.
  assert.equal(isWorkspaceContentLocked({
    visibility: 'private', workspaceType: 'private', currentPublishedVersionId: 'v1',
  }), false);
});

// ─── Role rules, unlocked ────────────────────────────────────────────────────

test('Freeflow lets owner, editor and contributor write; viewer never', () => {
  for (const role of ['owner', 'editor', 'contributor'] as Role[]) {
    assert.equal(resolve({ role, editingPolicy: 'direct' }).canEdit, true, role);
  }
  assert.equal(resolve({ role: 'viewer', editingPolicy: 'direct' }).canEdit, false);
});

test('Review admits only the owner to direct writes', () => {
  assert.equal(resolve({ role: 'owner', editingPolicy: 'review' }).canEdit, true);
  for (const role of ['editor', 'contributor', 'viewer'] as Role[]) {
    assert.equal(resolve({ role, editingPolicy: 'review' }).canEdit, false, role);
  }
});

test('a null editing policy is treated as Review', () => {
  // The stricter reading. A Shared row that reaches here without a policy should
  // not hand out write access by default.
  assert.equal(resolve({ role: 'contributor', editingPolicy: null }).canEdit, false);
});

test('a private workspace ignores the editing policy entirely', () => {
  assert.equal(resolve({ isShared: false, role: 'viewer', editingPolicy: 'review' }).canEdit, true);
});

// ─── The lock, applied ───────────────────────────────────────────────────────

test('the lock removes canEdit from every role that would otherwise have it', () => {
  for (const role of ['owner', 'editor', 'contributor'] as Role[]) {
    const locked = resolve({ role, editingPolicy: 'direct', contentLocked: true });
    assert.equal(locked.canEditRole, true, `${role} keeps the role right`);
    assert.equal(locked.canEdit, false, `${role} loses the live right`);
  }
});

test('canEditRole survives the lock so reads and config stay reachable', () => {
  // This split is what keeps listing a schedule or reading a knowledge source
  // from turning into an error the moment a workspace is locked.
  const locked = resolve({ role: 'owner', contentLocked: true });
  assert.equal(locked.canEditRole, true);
  assert.equal(locked.canEdit, false);
});

test('the lock does not promote a viewer', () => {
  const locked = resolve({ role: 'viewer', contentLocked: true });
  assert.equal(locked.canEditRole, false);
  assert.equal(locked.canEdit, false);
});

// ─── Lifecycle beats everything ──────────────────────────────────────────────

test('a trashed or purged workspace denies both rights regardless of role', () => {
  for (const status of ['trashed', 'purged'] as const) {
    const result = resolve({ role: 'owner', status });
    assert.equal(result.canEditRole, false, status);
    assert.equal(result.canEdit, false, status);
  }
});

// ─── Team grants across several teams ────────────────────────────────────────
//
// A workspace can be shared with any number of teams, each carrying its own
// role. The strongest one a person reaches wins.

test('the SQL rank and the TypeScript rank agree on team grant roles', () => {
  // `listWorkspacesForUser` picks the strongest grant with
  // `CASE role WHEN 'contributor' THEN 2 ELSE 1 END DESC`, because joining the
  // grants in would fan the row out. That ordering has to mean the same thing as
  // `WORKSPACE_ROLE_RANK`, and nothing but this test holds the two together.
  const sqlRank = (role: string) => (role === 'contributor' ? 2 : 1);
  const sorted = [...TEAM_GRANT_ROLES].sort((left, right) => sqlRank(right) - sqlRank(left));
  assert.deepEqual(sorted, ['contributor', 'viewer'], 'SQL ranks contributor above viewer');
  assert.equal(strongestWorkspaceRole(...TEAM_GRANT_ROLES), 'contributor');
});

test('a team grant never outranks a stronger direct grant', () => {
  assert.equal(strongestWorkspaceRole('editor', 'contributor'), 'editor');
  assert.equal(strongestWorkspaceRole('owner', 'contributor'), 'owner');
});

test('the strongest team role wins across several teams', () => {
  assert.equal(strongestWorkspaceRole('viewer', 'contributor'), 'contributor');
  assert.equal(strongestWorkspaceRole(null, 'viewer'), 'viewer');
});

test('a contributor reached through a team may edit a Freeflow workspace', () => {
  // The point of carrying the role per team rather than one role for the whole
  // workspace: a viewer grant from one team must not cap a contributor grant
  // from another.
  assert.equal(resolve({ role: strongestWorkspaceRole('viewer', 'contributor') }).canEdit, true);
  assert.equal(resolve({ role: strongestWorkspaceRole('viewer', null) }).canEdit, false);
});
