import assert from 'node:assert/strict';
import test from 'node:test';

import type { Workspace } from '@helpudoc/contracts/types';
import {
  getSharedWorkspaceLifecycleActions,
  isLinkedDraftAutoSyncEligible,
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
  assert.deepEqual(getSharedWorkspaceLifecycleActions(shared({ role: 'viewer' })), ['leave']);
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'contributor', status: 'unshared' })),
    ['leave'],
  );
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'viewer', status: 'trashed' })),
    [],
  );
  assert.deepEqual(
    getSharedWorkspaceLifecycleActions(shared({ role: 'viewer', audienceType: 'team' })),
    [],
  );
});

test('private workspaces never receive Shared lifecycle actions', () => {
  assert.deepEqual(getSharedWorkspaceLifecycleActions(draft()), []);
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
