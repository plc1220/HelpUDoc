/**
 * Regression tests for issue 2: a selected published version is an immutable snapshot, so the
 * canvas must be read-only while it is open. Editability used to depend on workspace permissions
 * alone, which made a published snapshot appear editable to anyone who could edit the workspace.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canMutateWorkspaceContent,
  isPublishedVersionFileId,
  isPublishedVersionMode,
  publishedVersionLabel,
  type PublishedVersionSelection,
} from '../src/utils/workspacePublicationMode.ts';
import type { Workspace } from '@helpudoc/contracts/types';

const sharedWorkspace: Workspace = {
  id: 'ws-shared',
  name: 'hartalega-aws-funding',
  lastUsed: '2026-08-01T00:00:00.000Z',
  visibility: 'team',
  role: 'owner',
  canEdit: true,
  canPublish: true,
  currentPublishedVersionNumber: 2,
};

const selection = (overrides: Partial<PublishedVersionSelection> = {}): PublishedVersionSelection => ({
  workspaceId: 'ws-shared',
  versionId: 'version-2',
  versionNumber: 2,
  note: 'Board pack',
  createdAt: '2026-08-01T09:00:00.000Z',
  isCurrent: true,
  ...overrides,
});

// ─── Published mode activation ───────────────────────────────────────────────

test('published mode is active for the workspace that owns the selected version', () => {
  assert.equal(isPublishedVersionMode(selection(), sharedWorkspace), true);
});

test('published mode is inactive with no selection', () => {
  assert.equal(isPublishedVersionMode(null, sharedWorkspace), false);
  assert.equal(isPublishedVersionMode(undefined, sharedWorkspace), false);
});

test('a selection from another workspace never locks the open workspace', () => {
  assert.equal(isPublishedVersionMode(selection({ workspaceId: 'ws-other' }), sharedWorkspace), false);
});

test('published mode is inactive when no workspace is open', () => {
  assert.equal(isPublishedVersionMode(selection(), null), false);
});

// ─── Mutation gating ─────────────────────────────────────────────────────────

test('the Shared Working version stays editable for an editor', () => {
  assert.equal(canMutateWorkspaceContent(sharedWorkspace, null), true);
});

test('a published snapshot is read-only even for the workspace owner', () => {
  assert.equal(canMutateWorkspaceContent(sharedWorkspace, selection()), false);
});

test('a withdrawn historical snapshot is read-only too', () => {
  assert.equal(
    canMutateWorkspaceContent(sharedWorkspace, selection({ versionId: 'version-1', versionNumber: 1, isCurrent: false })),
    false,
  );
});

test('workspace permissions still gate the Working version', () => {
  assert.equal(canMutateWorkspaceContent({ ...sharedWorkspace, canEdit: false }, null), false);
  assert.equal(canMutateWorkspaceContent({ ...sharedWorkspace, canEdit: false }, selection()), false);
});

test('a published selection for another workspace does not block editing', () => {
  assert.equal(canMutateWorkspaceContent(sharedWorkspace, selection({ workspaceId: 'ws-other' })), true);
});

test('no open workspace means nothing is mutable', () => {
  assert.equal(canMutateWorkspaceContent(null, null), false);
});

// ─── Read-only labelling and snapshot file identity ─────────────────────────

test('the banner label states the version and its read-only nature', () => {
  assert.equal(publishedVersionLabel(selection()), 'Locked v2 · Current · Read-only');
  assert.equal(
    publishedVersionLabel(selection({ versionNumber: 1, isCurrent: false })),
    'Locked v1 · Read-only',
  );
});

test('snapshot file ids are distinguishable from Working-version file ids', () => {
  assert.equal(isPublishedVersionFileId('published:version-2:commercials.md'), true);
  assert.equal(isPublishedVersionFileId('draft:plan.md'), false);
  assert.equal(isPublishedVersionFileId('1421'), false);
  assert.equal(isPublishedVersionFileId(1421), false);
  assert.equal(isPublishedVersionFileId(null), false);
  assert.equal(isPublishedVersionFileId(undefined), false);
});
