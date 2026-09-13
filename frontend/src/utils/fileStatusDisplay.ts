import type { File as WorkspaceFile, FileStatus, FileStatusState } from '../types';

/**
 * What a file's status chip shows, and how a completed transition folds back
 * into the file rows.
 *
 * Both the file list and the editor header render the chip from the same file
 * rows, so these two functions are the only place a status label is decided.
 * Keeping them here, pure, is also what makes them testable: the frontend test
 * runner is plain `node --test` with no DOM, so nothing that renders can be
 * covered.
 */

/**
 * Mirror of the server's `hasDrifted` in
 * `backend/src/services/fileStatusService.ts`. A decision attaches to the
 * version it was made on, so drift is that version no longer being the current
 * one.
 *
 * Only `approved` and `published` can drift. A `draft` or `in_review` file has
 * no live decision to have drifted from, even when an older
 * `approvedAtVersion` is still on the row — `backend/tests/fileStatusService.test.ts`
 * pins exactly that case. The previous inline version of this took
 * `approvedAtVersion` for every status other than `published`, which disagreed
 * with the server for a file that had been sent back to draft.
 */
export const deriveFileStatusChip = (
  file: Pick<WorkspaceFile, 'status' | 'version' | 'approvedAtVersion' | 'publishedAtVersion'>,
): { status: FileStatus; drift: boolean } => {
  const status = (file.status || 'draft') as FileStatus;
  const version = Number(file.version ?? 0);
  const decidedAt = status === 'approved'
    ? file.approvedAtVersion
    : status === 'published'
      ? file.publishedAtVersion
      : null;

  return {
    status,
    drift: decidedAt != null && Number(decidedAt) !== version,
  };
};

/**
 * Fold a completed transition into one file row.
 *
 * Returns the row untouched unless it is the file the transition applied to, so
 * callers can map this straight over their state. Ids are compared as strings:
 * `FileStatusState.fileId` is numeric on the wire while `File.id` is typed as a
 * string, and a strict compare would silently match nothing.
 *
 * Only the fields `FileStatusState` actually carries are written. `updatedAt` is
 * deliberately left alone — a status change is not a content change, and the
 * row's age label should keep reading from the last real edit.
 */
export const applyFileStatusState = (file: WorkspaceFile, next: FileStatusState): WorkspaceFile => {
  if (String(file.id) !== String(next.fileId)) return file;
  return {
    ...file,
    status: next.status,
    version: next.version,
    statusUpdatedAt: next.statusUpdatedAt ?? null,
    statusUpdatedBy: next.statusUpdatedBy ?? null,
    approvedAtVersion: next.approvedAtVersion ?? null,
    publishedAtVersion: next.publishedAtVersion ?? null,
  };
};
