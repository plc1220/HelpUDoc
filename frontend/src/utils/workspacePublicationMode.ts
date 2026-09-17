import type { Workspace } from '../types';

/**
 * A published version is an immutable snapshot (spec section 3.2). When one is selected the
 * workspace canvas switches to a read-only "published mode": the Shared Working version stays
 * editable, but nothing in the snapshot can be mutated.
 */
export type PublishedVersionSelection = {
  workspaceId: string;
  versionId: string;
  versionNumber: number;
  note: string | null;
  createdAt: string;
  isCurrent: boolean;
};

/**
 * Published mode is active only while the selected snapshot belongs to the open workspace,
 * so switching workspaces can never leave a stale read-only lock behind.
 */
export const isPublishedVersionMode = (
  selection: Pick<PublishedVersionSelection, 'workspaceId'> | null | undefined,
  workspace: Pick<Workspace, 'id'> | null | undefined,
): boolean => Boolean(selection && workspace && selection.workspaceId === workspace.id);

/**
 * A Shared workspace holding a current locked version is read-only for direct
 * content edits — for everyone, its owner included. Changes reach it only
 * through a private copy, a review submission, and a publisher applying it.
 *
 * The server is the authority (`canEdit` already carries this), but the state is
 * derived here too so the UI can say *why* the canvas is read-only and offer the
 * private-copy route, rather than just greying controls out.
 */
export const isWorkspaceContentLocked = (
  workspace: Pick<Workspace, 'visibility' | 'currentPublishedVersionId'> | null | undefined,
): boolean => workspace?.visibility === 'team' && Boolean(workspace.currentPublishedVersionId);

/**
 * Single source of truth for "may the user mutate what is currently on the canvas?".
 * Workspace permissions still apply; published mode and the workspace lock are
 * additional, stricter gates.
 */
export const canMutateWorkspaceContent = (
  workspace:
    | Pick<Workspace, 'id' | 'canEdit' | 'visibility' | 'currentPublishedVersionId'>
    | null
    | undefined,
  selection: Pick<PublishedVersionSelection, 'workspaceId'> | null | undefined,
): boolean => Boolean(workspace?.canEdit)
  && !isWorkspaceContentLocked(workspace)
  && !isPublishedVersionMode(selection, workspace);

export const publishedVersionLabel = (
  selection: Pick<PublishedVersionSelection, 'versionNumber' | 'isCurrent'>,
): string => `Locked v${selection.versionNumber}${selection.isCurrent ? ' · Current' : ''} · Read-only`;

export const isPublishedVersionFileId = (fileId: string | number | null | undefined): boolean =>
  typeof fileId === 'string' && fileId.startsWith('published:');
