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
  isFileContentProtected,
  isWorkspaceContentLocked,
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

// ─── Locked workspaces ───────────────────────────────────────────────────────
//
// Locking a Shared workspace makes it read-only for direct edits, for everyone
// including its owner. It used to save a snapshot and leave the live workspace
// as writable as before, which is how a contributor could edit a "locked"
// workspace and then find nothing would accept the result.

const lockedWorkspace: Workspace = {
  ...sharedWorkspace,
  currentPublishedVersionId: 'version-2',
};

test('a Shared workspace holding a current version is locked', () => {
  assert.equal(isWorkspaceContentLocked(lockedWorkspace), true);
});

test('a Shared workspace with no current version is not locked', () => {
  assert.equal(isWorkspaceContentLocked({ ...sharedWorkspace, currentPublishedVersionId: null }), false);
});

test('a private workspace is never locked, even carrying a version id', () => {
  assert.equal(isWorkspaceContentLocked({
    ...sharedWorkspace,
    visibility: 'private',
    currentPublishedVersionId: 'version-2',
  }), false);
});

test('a missing workspace is not locked', () => {
  assert.equal(isWorkspaceContentLocked(null), false);
  assert.equal(isWorkspaceContentLocked(undefined), false);
});

test('the canvas is read-only in a locked workspace even for an owner who can edit', () => {
  // `canEdit` arrives from the server already lock-aware; this asserts the
  // client reaches the same verdict rather than depending on that alone.
  assert.equal(canMutateWorkspaceContent(lockedWorkspace, null), false);
});

test('withdrawing the lock returns the canvas to editable', () => {
  assert.equal(
    canMutateWorkspaceContent({ ...sharedWorkspace, currentPublishedVersionId: null }, null),
    true,
  );
});

test('a locked workspace stays read-only with a snapshot open', () => {
  assert.equal(canMutateWorkspaceContent(lockedWorkspace, selection()), false);
});

test('the lock does not grant edit rights the role never had', () => {
  assert.equal(
    canMutateWorkspaceContent(
      { ...sharedWorkspace, canEdit: false, currentPublishedVersionId: null },
      null,
    ),
    false,
  );
});

// ─── Signed-off files ────────────────────────────────────────────────────────
//
// Status used to be a record rather than a lock: approval pinned a version,
// editing bumped past it, and the only trace was a drift badge.

const openWorkspace: Workspace = { ...sharedWorkspace, currentPublishedVersionId: null };

test('approved and published files are read-only; earlier states are not', () => {
  assert.equal(isFileContentProtected({ status: 'approved' }, openWorkspace), true);
  assert.equal(isFileContentProtected({ status: 'published' }, openWorkspace), true);
  assert.equal(isFileContentProtected({ status: 'in_review' }, openWorkspace), false);
  assert.equal(isFileContentProtected({ status: 'draft' }, openWorkspace), false);
});

test('a private workspace never protects a file, whatever status it inherited', () => {
  // Sync copies the status but leaves the published artifact behind, and a
  // private copy exists to draft changes to a signed-off document.
  const privateCopy: Workspace = { ...openWorkspace, visibility: 'private' };
  assert.equal(isFileContentProtected({ status: 'published' }, privateCopy), false);
  assert.equal(isFileContentProtected({ status: 'approved' }, privateCopy), false);
});

test('a missing file or workspace is not protected', () => {
  assert.equal(isFileContentProtected(null, openWorkspace), false);
  assert.equal(isFileContentProtected({ status: 'approved' }, null), false);
});

test('the canvas refuses an approved file even in an editable workspace', () => {
  assert.equal(canMutateWorkspaceContent(openWorkspace, null, { status: 'approved' }), false);
  assert.equal(canMutateWorkspaceContent(openWorkspace, null, { status: 'draft' }), true);
});

test('omitting the file leaves the workspace-level answer unchanged', () => {
  // Callers that ask about the canvas without a file open must not be refused.
  assert.equal(canMutateWorkspaceContent(openWorkspace, null), true);
});
