/**
 * Regression tests for issue 1: a `My draft` workspace linked to a Shared workspace must expose
 * an explicit `Sync latest` action whenever its status is `team_updates_available` or
 * `review_needed` — the sidebar used to render status text only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_REVIEW_CHANGES_ACTION_LABEL,
  DRAFT_SYNC_ACTIONABLE_STATUSES,
  DRAFT_SYNC_ACTION_LABEL,
  extractSyncConflicts,
  isDraftReviewChangesActionable,
  isDraftSyncActionable,
  isLinkedDraftWorkspace,
} from '../src/utils/workspaceDraftSync.ts';
import type { Workspace } from '@helpudoc/contracts/types';

const draft = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-draft',
  name: 'My draft · hartalega-aws-funding',
  lastUsed: '2026-08-01T00:00:00.000Z',
  visibility: 'private',
  linkedTeamWorkspaceId: 'ws-shared',
  role: 'owner',
  ...overrides,
});

// ─── Sync action availability ────────────────────────────────────────────────

test('the actionable statuses are exactly the two spec sync states', () => {
  assert.deepEqual([...DRAFT_SYNC_ACTIONABLE_STATUSES], ['team_updates_available', 'review_needed']);
});

test('Sync latest is offered when the Shared Working version moved ahead', () => {
  assert.equal(isDraftSyncActionable(draft({ publicationStatus: 'team_updates_available' })), true);
});

test('Sync latest is offered when the draft needs review-time sync', () => {
  assert.equal(isDraftSyncActionable(draft({ publicationStatus: 'review_needed' })), true);
});

test('Sync latest is not offered for an up-to-date draft', () => {
  assert.equal(isDraftSyncActionable(draft({ publicationStatus: 'up_to_date' })), false);
  assert.equal(isDraftSyncActionable(draft({ publicationStatus: undefined })), false);
});

test('Sync latest is not offered for an unlinked private workspace', () => {
  assert.equal(
    isDraftSyncActionable(draft({ linkedTeamWorkspaceId: null, publicationStatus: 'team_updates_available' })),
    false,
  );
});

test('Sync latest is not offered on the Shared workspace itself', () => {
  assert.equal(
    isDraftSyncActionable(draft({ visibility: 'team', publicationStatus: 'team_updates_available' })),
    false,
  );
});

test('Sync latest is not offered for a missing workspace', () => {
  assert.equal(isDraftSyncActionable(null), false);
  assert.equal(isDraftSyncActionable(undefined), false);
});

test('linked-draft detection ignores publication status', () => {
  assert.equal(isLinkedDraftWorkspace(draft()), true);
  assert.equal(isLinkedDraftWorkspace(draft({ linkedTeamWorkspaceId: null })), false);
  assert.equal(isLinkedDraftWorkspace(draft({ visibility: 'team' })), false);
});

test('the action uses the spec vocabulary rather than internal rebase wording', () => {
  assert.equal(DRAFT_SYNC_ACTION_LABEL, 'Sync latest');
  assert.ok(!/rebase/i.test(DRAFT_SYNC_ACTION_LABEL));
});

test('Sync latest is not offered for a draft that only holds private changes', () => {
  // Nothing advanced on the Shared side, so there is nothing to sync — the draft is reviewed instead.
  assert.equal(isDraftSyncActionable(draft({ publicationStatus: 'changes_to_publish' })), false);
});

// ─── Review changes availability ─────────────────────────────────────────────

test('Review changes is the primary action for a draft with private changes', () => {
  assert.equal(DRAFT_REVIEW_CHANGES_ACTION_LABEL, 'Review changes');
  assert.equal(isDraftReviewChangesActionable(draft({ publicationStatus: 'changes_to_publish' })), true);
});

test('Review changes is not offered while the draft has nothing private to review', () => {
  assert.equal(isDraftReviewChangesActionable(draft({ publicationStatus: 'up_to_date' })), false);
  assert.equal(isDraftReviewChangesActionable(draft({ publicationStatus: 'team_updates_available' })), false);
  assert.equal(isDraftReviewChangesActionable(draft({ publicationStatus: 'review_needed' })), false);
  assert.equal(isDraftReviewChangesActionable(draft({ publicationStatus: undefined })), false);
});

test('Review changes is not offered for unlinked private or Shared workspaces', () => {
  assert.equal(
    isDraftReviewChangesActionable(draft({ linkedTeamWorkspaceId: null, publicationStatus: 'changes_to_publish' })),
    false,
  );
  assert.equal(
    isDraftReviewChangesActionable(draft({ visibility: 'team', publicationStatus: 'changes_to_publish' })),
    false,
  );
  assert.equal(isDraftReviewChangesActionable(null), false);
  assert.equal(isDraftReviewChangesActionable(undefined), false);
});

test('Sync latest and Review changes never compete for the same draft state', () => {
  const statuses = [
    'private_draft',
    'up_to_date',
    'changes_to_publish',
    'withdrawn',
    'team_updates_available',
    'review_needed',
  ] as const;
  for (const publicationStatus of statuses) {
    const workspace = draft({ publicationStatus });
    assert.ok(
      !(isDraftSyncActionable(workspace) && isDraftReviewChangesActionable(workspace)),
      `both actions offered for ${publicationStatus}`,
    );
  }
});

// ─── Conflict hand-off into the existing sync/conflict flow ─────────────────

test('conflicts are extracted from the 409 sync error details', () => {
  const conflicts = extractSyncConflicts({
    code: 'REVIEW_NEEDED',
    conflicts: [
      { path: 'commercials.md', privateChange: 'changed', teamChange: 'changed' },
      { path: 'scope.md', privateChange: 'added', teamChange: 'added' },
    ],
  });
  assert.deepEqual(conflicts.map((conflict) => conflict.path), ['commercials.md', 'scope.md']);
});

test('malformed or empty conflict payloads never open the resolve dialog', () => {
  assert.deepEqual(extractSyncConflicts(undefined), []);
  assert.deepEqual(extractSyncConflicts(null), []);
  assert.deepEqual(extractSyncConflicts('boom'), []);
  assert.deepEqual(extractSyncConflicts({}), []);
  assert.deepEqual(extractSyncConflicts({ conflicts: 'nope' }), []);
  assert.deepEqual(extractSyncConflicts({ conflicts: [] }), []);
});

test('conflict entries without a usable path are dropped', () => {
  const conflicts = extractSyncConflicts({
    conflicts: [null, 42, { privateChange: 'changed' }, { path: 'kept.md' }],
  });
  assert.deepEqual(conflicts.map((conflict) => conflict.path), ['kept.md']);
});
