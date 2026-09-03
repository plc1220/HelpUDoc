import assert from 'node:assert/strict';
import test from 'node:test';

import type { Workspace } from '@helpudoc/contracts/types';
import {
  resolveWorkspaceToRestore,
  shouldPersistWorkspaceOpen,
} from '../src/utils/workspaceRestore.ts';

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'workspace-1',
  name: 'My workspace',
  lastUsed: '2026-08-10T00:00:00.000Z',
  visibility: 'private',
  role: 'owner',
  status: 'active',
  ...overrides,
});

test('restores an active workspace that is still in the list', () => {
  const target = workspace();
  assert.equal(resolveWorkspaceToRestore([workspace({ id: 'other' }), target], 'workspace-1'), target);
});

test('no stored id means a first-time user, so no restore', () => {
  assert.equal(resolveWorkspaceToRestore([workspace()], null), null);
  assert.equal(resolveWorkspaceToRestore([workspace()], undefined), null);
});

test('an empty or whitespace id does not restore', () => {
  // `??` would let these through; the landing page is the correct outcome.
  assert.equal(resolveWorkspaceToRestore([workspace()], ''), null);
  assert.equal(resolveWorkspaceToRestore([workspace()], '   '), null);
});

test('stringified nullish ids from a bad round-trip do not restore', () => {
  assert.equal(resolveWorkspaceToRestore([workspace()], 'undefined'), null);
  assert.equal(resolveWorkspaceToRestore([workspace()], 'null'), null);
});

test('a dangling id absent from the list does not restore', () => {
  // Deleted, purged, or access revoked. The column has no foreign key by design,
  // so this is the expected steady state, not an error.
  assert.equal(resolveWorkspaceToRestore([workspace()], 'deleted-workspace'), null);
  assert.equal(resolveWorkspaceToRestore([], 'workspace-1'), null);
});

test('a trashed workspace does not restore', () => {
  const trashed = workspace({ status: 'trashed' });
  assert.equal(resolveWorkspaceToRestore([trashed], 'workspace-1'), null);
});

test('an unshared workspace still restores', () => {
  // The backend lists `unshared` only for its owner, and the sidebar lets that
  // owner open it — restoring must mirror the same openability rule.
  const unshared = workspace({ visibility: 'team', status: 'unshared' });
  assert.equal(resolveWorkspaceToRestore([unshared], 'workspace-1'), unshared);
});

test('the legacy archived status is treated as unshared and still restores', () => {
  const archived = workspace({ visibility: 'team', status: 'archived' as Workspace['status'] });
  assert.equal(resolveWorkspaceToRestore([archived], 'workspace-1'), archived);
});

test('a workspace with no status is treated as active', () => {
  const untyped = workspace({ status: undefined });
  assert.equal(resolveWorkspaceToRestore([untyped], 'workspace-1'), untyped);
});

test('persists an open workspace once the landing page is gone', () => {
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: 'workspace-1',
    isLandingPageVisible: false,
    alreadyPersistedId: null,
  }), true);
});

test('does not persist while the landing page is still up', () => {
  // `handleCreateWorkspace({ stayOnLanding: true })` and the landing picker for a
  // workspace with no conversations both select without entering.
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: 'workspace-1',
    isLandingPageVisible: true,
    alreadyPersistedId: null,
  }), false);
});

test('does not persist the same workspace twice', () => {
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: 'workspace-1',
    isLandingPageVisible: false,
    alreadyPersistedId: 'workspace-1',
  }), false);
});

test('persists a different workspace after a previous one', () => {
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: 'workspace-2',
    isLandingPageVisible: false,
    alreadyPersistedId: 'workspace-1',
  }), true);
});

test('does not persist when nothing is selected', () => {
  // Deleting or trashing the selected workspace clears it; the stored preference is
  // deliberately left alone, and the read path filters it out next time.
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: null,
    isLandingPageVisible: false,
    alreadyPersistedId: 'workspace-1',
  }), false);
  assert.equal(shouldPersistWorkspaceOpen({
    workspaceId: undefined,
    isLandingPageVisible: true,
    alreadyPersistedId: null,
  }), false);
});
