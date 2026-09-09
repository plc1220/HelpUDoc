import type { File as WorkspaceFile } from '../types';

/**
 * Owner grouping for the file list.
 *
 * "Owner" is the file's creator, not whoever last touched its status. A file
 * changes hands far less often than it changes state, so creator is the stable
 * thing to filter by.
 *
 * Ids are resolved to names against the workspace collaborators. An id with no
 * name still gets an option rather than being dropped: a file whose creator has
 * since left the workspace is exactly the file someone needs to find.
 */

export const ALL_OWNERS = 'all' as const;

/** No creator recorded — files imported or generated before the column existed. */
export const UNATTRIBUTED_OWNER = 'unattributed' as const;

export type FileOwnerFilter = string;

export type FileOwnerOption = {
  /** The value passed to onChange; a user id, or UNATTRIBUTED_OWNER. */
  id: string;
  label: string;
  count: number;
};

const UNKNOWN_LABEL = 'Former member';
const UNATTRIBUTED_LABEL = 'No owner';

/** The bucket a file belongs to. Kept in one place so the filter and the count agree. */
export const getFileOwnerId = (file: WorkspaceFile): string =>
  file.createdBy || UNATTRIBUTED_OWNER;

export const matchesOwnerFilter = (file: WorkspaceFile, filter: FileOwnerFilter): boolean =>
  filter === ALL_OWNERS || getFileOwnerId(file) === filter;

/**
 * The options to offer, ordered by how many files each owner has, then by name.
 * Frequency first because the point of the filter is to reach the busiest owner
 * quickly, and a workspace can carry a long tail of one-file contributors.
 */
export const buildFileOwnerOptions = (
  files: WorkspaceFile[],
  displayNameById: Record<string, string>,
): FileOwnerOption[] => {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ownerId = getFileOwnerId(file);
    counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([id, count]) => ({
      id,
      label: id === UNATTRIBUTED_OWNER
        ? UNATTRIBUTED_LABEL
        : displayNameById[id] || UNKNOWN_LABEL,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

/** The name to print on a file row. Empty when there is nothing worth showing. */
export const getFileOwnerLabel = (
  file: WorkspaceFile,
  displayNameById: Record<string, string>,
): string => {
  const ownerId = getFileOwnerId(file);
  if (ownerId === UNATTRIBUTED_OWNER) return '';
  return displayNameById[ownerId] || UNKNOWN_LABEL;
};
