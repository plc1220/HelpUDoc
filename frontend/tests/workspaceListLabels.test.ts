/**
 * Tests for the workspace sidebar status vocabulary (spec sections 2.3-2.4, 8.3 and 17).
 * Verifies that:
 *  - Freeflow/Review badges are no longer shown
 *  - 'Private copy' is replaced with 'My draft' terminology
 *  - each linked draft state maps to its own actionable label
 *  - actionable statuses are shown for shared workspaces
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPrivateWorkspaceStatusLabel,
  getSharedWorkspacePublicationLabel,
  getSharedWorkspaceStatusDetails,
} from '../src/utils/workspaceStatusLabels.ts';
import type { Workspace } from '@helpudoc/contracts/types';

const baseWorkspace: Workspace = {
  id: 'ws-1',
  name: 'Test workspace',
  lastUsed: new Date().toISOString(),
  visibility: 'team',
  editingPolicy: 'direct',
  role: 'owner',
};

const draft = (overrides: Partial<Workspace> = {}): Workspace => ({
  ...baseWorkspace,
  visibility: 'private',
  linkedTeamWorkspaceId: 'ws-shared-1',
  ...overrides,
});

// ─── Shared workspace labels ─────────────────────────────────────────────────

test('shared workspace with no publication shows "Working version"', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'up_to_date',
    currentPublishedVersionNumber: null,
  };
  assert.equal(getSharedWorkspacePublicationLabel(ws), 'Working version');
});

test('shared workspace with locked version shows version number', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'up_to_date',
    currentPublishedVersionNumber: 3,
  };
  assert.equal(getSharedWorkspacePublicationLabel(ws), 'Locked v3');
});

test('shared workspace with changes shows unlocked changes', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'changes_to_publish',
    currentPublishedVersionNumber: 2,
  };
  assert.equal(getSharedWorkspacePublicationLabel(ws), 'Locked v2 · Changes not locked');
});

test('withdrawn lock shows "No current locked version"', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'withdrawn',
    currentPublishedVersionNumber: 1,
  };
  assert.equal(getSharedWorkspacePublicationLabel(ws), 'No current locked version');
});

test('shared details include proposal count when present', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'up_to_date',
    currentPublishedVersionNumber: 2,
  };
  assert.equal(
    getSharedWorkspaceStatusDetails({ ...ws, pendingProposalCount: 3 }),
    'Locked v2 · 3 proposals pending',
  );
  assert.equal(
    getSharedWorkspaceStatusDetails({ ...ws, pendingProposalCount: 1 }),
    'Locked v2 · 1 proposal pending',
  );
});

test('shared details omit proposal count when zero or undefined', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'up_to_date',
    currentPublishedVersionNumber: null,
  };
  assert.equal(getSharedWorkspaceStatusDetails({ ...ws, pendingProposalCount: 0 }), 'Working version');
  assert.equal(getSharedWorkspaceStatusDetails(ws), 'Working version');
});

test('shared workspace labels never contain Freeflow or Review', () => {
  const directWs: Workspace = { ...baseWorkspace, editingPolicy: 'direct', publicationStatus: 'up_to_date' };
  const reviewWs: Workspace = { ...baseWorkspace, editingPolicy: 'review', publicationStatus: 'up_to_date' };
  const directLabel = getSharedWorkspaceStatusDetails(directWs);
  const reviewLabel = getSharedWorkspaceStatusDetails(reviewWs);
  assert.ok(!directLabel.includes('Freeflow'));
  assert.ok(!directLabel.includes('Review'));
  assert.ok(!reviewLabel.includes('Freeflow'));
  assert.ok(!reviewLabel.includes('Review'));
});

test('shared workspace labels use Locked wording instead of Published', () => {
  const statuses: Array<Workspace['publicationStatus']> = [
    'up_to_date',
    'changes_to_publish',
    'withdrawn',
  ];
  for (const publicationStatus of statuses) {
    for (const currentPublishedVersionNumber of [null, 0, 2]) {
      const label = getSharedWorkspacePublicationLabel({
        ...baseWorkspace,
        publicationStatus,
        currentPublishedVersionNumber,
      });
      assert.ok(
        !/[Pp]ublish/.test(label),
        `unexpected publish wording in "${label}" for ${String(publicationStatus)}/${currentPublishedVersionNumber}`,
      );
    }
  }
});

// ─── Private draft labels ────────────────────────────────────────────────────

test('private workspace without linked shows "Private"', () => {
  assert.equal(getPrivateWorkspaceStatusLabel(draft({ linkedTeamWorkspaceId: null })), 'Private');
  assert.equal(
    getPrivateWorkspaceStatusLabel(draft({ linkedTeamWorkspaceId: null, publicationStatus: 'private_draft' })),
    'Private',
  );
});

test('linked draft with local private changes shows "My draft · Private changes"', () => {
  assert.equal(
    getPrivateWorkspaceStatusLabel(draft({ publicationStatus: 'changes_to_publish' })),
    'My draft · Private changes',
  );
});

test('linked draft whose Shared version advanced shows "My draft · Shared changed"', () => {
  assert.equal(
    getPrivateWorkspaceStatusLabel(draft({ publicationStatus: 'team_updates_available' })),
    'My draft · Shared changed',
  );
});

test('linked draft with overlapping changes shows "My draft · Needs sync"', () => {
  assert.equal(
    getPrivateWorkspaceStatusLabel(draft({ publicationStatus: 'review_needed' })),
    'My draft · Needs sync',
  );
});

test('linked draft matching its base shows "My draft · Up to date"', () => {
  assert.equal(
    getPrivateWorkspaceStatusLabel(draft({ publicationStatus: 'up_to_date' })),
    'My draft · Up to date',
  );
});

test('private draft labels never contain "Private copy" or internal status names', () => {
  const statuses: Array<Workspace['publicationStatus']> = [
    'private_draft',
    'up_to_date',
    'changes_to_publish',
    'withdrawn',
    'team_updates_available',
    'review_needed',
    undefined,
  ];
  for (const publicationStatus of statuses) {
    const label = getPrivateWorkspaceStatusLabel(draft({ publicationStatus }));
    assert.ok(!label.includes('Private copy'), `failed for ${String(publicationStatus)}`);
    assert.ok(!/_/.test(label), `failed for ${String(publicationStatus)}`);
  }
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('changes_to_publish with version 0 shows only "Changes not locked"', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'changes_to_publish',
    currentPublishedVersionNumber: 0,
  };
  assert.equal(getSharedWorkspacePublicationLabel(ws), 'Changes not locked');
});

test('withdrawn label is independent of version number', () => {
  for (const versionNumber of [0, 1, 5, null]) {
    const ws: Workspace = {
      ...baseWorkspace,
      publicationStatus: 'withdrawn',
      currentPublishedVersionNumber: versionNumber,
    };
    assert.equal(
      getSharedWorkspacePublicationLabel(ws),
      'No current locked version',
      `failed for versionNumber=${versionNumber}`,
    );
  }
});

test('shared details combine publication and proposal count', () => {
  const ws: Workspace = {
    ...baseWorkspace,
    publicationStatus: 'changes_to_publish',
    currentPublishedVersionNumber: 1,
    pendingProposalCount: 2,
  };
  assert.equal(
    getSharedWorkspaceStatusDetails(ws),
    'Locked v1 · Changes not locked · 2 proposals pending',
  );
});

test('linked draft with undefined publicationStatus falls back to "My draft · Linked"', () => {
  assert.equal(getPrivateWorkspaceStatusLabel(draft()), 'My draft · Linked');
});

test('a missing workspace is treated as an unlinked private workspace', () => {
  assert.equal(getPrivateWorkspaceStatusLabel(null), 'Private');
  assert.equal(getPrivateWorkspaceStatusLabel(undefined), 'Private');
});
