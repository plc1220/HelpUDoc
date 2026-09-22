import type { Workspace } from '../types';

/**
 * Sidebar status vocabulary for the workspace list. The strings here follow the private/shared
 * workspace spec (sections 2.3-2.4, 8.3 and 17): the sidebar always shows the user-facing state of
 * `My draft` instead of internal workflow terminology.
 */

type PrivateWorkspaceLike = Pick<Workspace, 'linkedTeamWorkspaceId' | 'publicationStatus'>;

type SharedWorkspaceLike = Pick<
  Workspace,
  'status' | 'publicationStatus' | 'currentPublishedVersionNumber' | 'purgeAfter'
>;

/** Unlinked private workspaces are just private; there is no draft relationship to describe. */
export const UNLINKED_PRIVATE_LABEL = 'Private';

/** Used when the backend has not reported a draft status yet. */
export const LINKED_DRAFT_FALLBACK_LABEL = 'My draft · Linked';

/**
 * Spec section 8.3 maps each draft state to a single user-facing status:
 *   - `changes_to_publish`      -> local private edits waiting to be reviewed/submitted
 *   - `team_updates_available`  -> the Shared Working version moved ahead
 *   - `review_needed`           -> both sides moved, so the draft must sync before submitting
 *   - `up_to_date`              -> nothing to do
 */
export const getPrivateWorkspaceStatusLabel = (
  workspace: PrivateWorkspaceLike | null | undefined,
): string => {
  if (workspace?.publicationStatus === 'detached') return 'My draft · Detached';
  if (!workspace?.linkedTeamWorkspaceId) return UNLINKED_PRIVATE_LABEL;
  switch (workspace.publicationStatus) {
    case 'changes_to_publish':
      return 'My draft · Private changes';
    case 'team_updates_available':
      // "Shared changed" reported a fact about somewhere else and left the
      // reader to work out that it concerned them. This names the thing that
      // is waiting, and matches the `Sync latest` button beside it.
      return 'My draft · Update ready';
    case 'review_needed':
      return 'My draft · Needs sync';
    case 'up_to_date':
      return 'My draft · Up to date';
    default:
      return LINKED_DRAFT_FALLBACK_LABEL;
  }
};

/** Publication state of a Shared workspace, in the spec's `Working version` vocabulary. */
export const getSharedWorkspacePublicationLabel = (workspace: SharedWorkspaceLike): string => {
  if (workspace.status === 'trashed') return 'In trash';
  if (workspace.status === 'unshared') return 'Unshared';
  if (workspace.publicationStatus === 'withdrawn') return 'No current locked version';
  const versionNumber = workspace.currentPublishedVersionNumber;
  if (versionNumber == null) return 'Working version';
  if (workspace.publicationStatus === 'changes_to_publish') {
    // "Changes not locked" beside "Locked vN" read as though the lock had
    // lapsed. It has not: the workspace is still read-only, and the only route
    // in is an approved proposal, so what is waiting is work that arrived.
    return versionNumber > 0
      ? `Locked v${versionNumber} · Incoming new changes`
      : 'Incoming new changes';
  }
  return `Locked v${versionNumber}`;
};

/**
 * Publication state shown on the Shared workspace row.
 *
 * The pending count used to be appended here as a bare number, which produced
 * `Locked v2 · 3` — two unlabelled numerals side by side, where one means a
 * version and the other means work waiting for you. The count now renders as
 * its own badge so it can carry a colour and a name; see
 * `getPendingReviewLabel`.
 */
export const getSharedWorkspaceStatusDetails = (workspace: SharedWorkspaceLike): string => {
  if (workspace.status === 'trashed') {
    if (!workspace.purgeAfter) return 'In trash';
    const purgeDate = new Date(workspace.purgeAfter);
    return Number.isNaN(purgeDate.getTime())
      ? 'In trash'
      : `In trash · Deletes ${purgeDate.toLocaleDateString()}`;
  }
  if (workspace.status === 'unshared') return 'Unshared · Only you can access it';
  return getSharedWorkspacePublicationLabel(workspace);
};

/**
 * Names the pending count wherever it is shown: the sidebar badge, the
 * workspace banner and the review queue heading.
 *
 * One function because the wording has to match in all three. It previously did
 * not — the dialog said "Submission", the tooltip said "proposal", the sidebar
 * label said "Incoming new changes" — and a reader had no way to tell they were
 * the same thing.
 */
export const getPendingReviewLabel = (count: number): string => (
  `${count} ${count === 1 ? 'change' : 'changes'} for review`
);
