import assert from 'node:assert/strict';
import test from 'node:test';

import type { Workspace } from '@helpudoc/contracts/types';
import {
  getSharedWorkspaceLifecycleActions,
  isLinkedDraftAutoSyncEligible,
  isOwnerOnlyUnsharedWorkspace,
  isTeamChatFrozen,
} from '../src/utils/workspaceLifecycle.ts';

const shared = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'shared-1',
  name: 'Shared workspace',
  lastUsed: '2026-08-10T00:00:00.000Z',
  visibility: 'team',
  role: 'owner',
  status: 'active',
  ...overrides,
});

const draft = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'draft-1',
  name: 'My draft',
  lastUsed: '2026-08-10T00:00:00.000Z',
  visibility: 'private',
  role: 'owner',
  status: 'active',
  linkedTeamWorkspaceId: 'shared-1',
  publicationStatus: 'team_updates_available',
  ...overrides,
});

test('Shared owners use reversible lifecycle actions instead of hard delete', () => {
  assert.deepEqual(getSharedWorkspaceLifecycleActions(shared()), ['unshare', 'trash']);
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ status: 'unshared' })),
    ['reshare', 'trash'],
  );
  assert.deepEqual(getSharedWorkspaceLifecycleActions(shared({ status: 'trashed' })), ['restore']);
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ status: 'archived' } as Partial<Workspace>)),
    ['reshare', 'trash'],
  );
});

test('Shared members may leave but cannot control sharing or trash', () => {
  assert.deepEqual(getSharedWorkspaceLifecycleActions(shared({ role: 'viewer', canLeave: true })), ['leave']);
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'contributor', status: 'unshared', canLeave: true })),
    ['leave'],
  );
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'viewer', status: 'trashed', canLeave: true })),
    [],
    'a trashed workspace offers restore only, whatever the server said about leaving',
  );
});

test('leaving is offered only when the server says it is possible', () => {
  // `canLeave` replaced `audienceType`: the question is about the person, not
  // the workspace. A named collaborator on a team-shared workspace can leave; a
  // member who is only there through the team cannot.
  assert.deepEqual(getSharedWorkspaceLifecycleActions(shared({ role: 'viewer', canLeave: false })), []);
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'viewer' })),
    [],
    'absent means no, so a stale payload cannot offer an action the server will refuse',
  );
});

test('private workspaces never receive Shared lifecycle actions', () => {
  assert.deepEqual(getSharedWorkspaceLifecycleActions(draft()), []);
});

test('unshared Shared workspaces are owner-only items in the Private section', () => {
  assert.equal(isOwnerOnlyUnsharedWorkspace(shared({ status: 'unshared' })), true);
  assert.equal(isOwnerOnlyUnsharedWorkspace(shared()), false);
  assert.equal(isOwnerOnlyUnsharedWorkspace(draft()), false);
});

test('explicit-open autosync requires an active draft and active linked Shared workspace', () => {
  assert.equal(isLinkedDraftAutoSyncEligible(draft(), [shared()]), true);
  assert.equal(
    isLinkedDraftAutoSyncEligible(draft({ publicationStatus: 'review_needed' }), [shared()]),
    true,
  );
  assert.equal(isLinkedDraftAutoSyncEligible(draft({ status: 'trashed' }), [shared()]), false);
  assert.equal(isLinkedDraftAutoSyncEligible(draft(), [shared({ status: 'unshared' })]), false);
  assert.equal(isLinkedDraftAutoSyncEligible(draft(), [shared({ status: 'trashed' })]), false);
});

test('detached, unlinked, up-to-date, and orphaned drafts never autosync', () => {
  assert.equal(
    isLinkedDraftAutoSyncEligible(draft({ publicationStatus: 'detached' }), [shared()]),
    false,
  );
  assert.equal(
    isLinkedDraftAutoSyncEligible(draft({ linkedTeamWorkspaceId: null }), [shared()]),
    false,
  );
  assert.equal(
    isLinkedDraftAutoSyncEligible(draft({ publicationStatus: 'up_to_date' }), [shared()]),
    false,
  );
  assert.equal(isLinkedDraftAutoSyncEligible(draft(), []), false);
});

// ─── Frozen Team Chat ────────────────────────────────────────────────────────
//
// Unsharing leaves `visibility` at 'team' and only moves `status`, so a shared
// workspace keeps its collaboration surface while nobody but the owner can
// reach it. The history stays readable; new writes stop.

test('an unshared workspace freezes Team Chat', () => {
  assert.equal(isTeamChatFrozen({ visibility: 'team', status: 'unshared' }), true);
});

test('archived is the legacy spelling of unshared and freezes too', () => {
  assert.equal(isTeamChatFrozen({ visibility: 'team', status: 'archived' } as never), true);
});

test('a trashed shared workspace is frozen', () => {
  assert.equal(isTeamChatFrozen({ visibility: 'team', status: 'trashed' }), true);
});

test('an active shared workspace is not frozen', () => {
  // The control. A predicate that freezes everything looks the same as one
  // that works.
  assert.equal(isTeamChatFrozen({ visibility: 'team', status: 'active' }), false);
  assert.equal(isTeamChatFrozen({ visibility: 'team' }), false, 'absent status means active');
});

test('a private workspace has no Team Chat to freeze', () => {
  assert.equal(isTeamChatFrozen({ visibility: 'private', status: 'unshared' }), false);
  assert.equal(isTeamChatFrozen(null), false);
  assert.equal(isTeamChatFrozen(undefined), false);
});
