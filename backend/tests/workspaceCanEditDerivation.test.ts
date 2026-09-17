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
  isWorkspaceContentLocked,
  resolveWorkspaceContentEditAccess,
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
