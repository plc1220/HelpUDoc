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
 * Single source of truth for "may the user mutate what is currently on the canvas?".
 * Workspace permissions still apply; published mode is an additional, stricter gate.
 */
export const canMutateWorkspaceContent = (
  workspace: Pick<Workspace, 'id' | 'canEdit'> | null | undefined,
  selection: Pick<PublishedVersionSelection, 'workspaceId'> | null | undefined,
): boolean => Boolean(workspace?.canEdit) && !isPublishedVersionMode(selection, workspace);

export const publishedVersionLabel = (
  selection: Pick<PublishedVersionSelection, 'versionNumber' | 'isCurrent'>,
): string => `Locked v${selection.versionNumber}${selection.isCurrent ? ' · Current' : ''} · Read-only`;

export const isPublishedVersionFileId = (fileId: string | number | null | undefined): boolean =>
  typeof fileId === 'string' && fileId.startsWith('published:');
