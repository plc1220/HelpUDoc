import type { Workspace } from '../types';

/**
 * Sidebar status vocabulary for the workspace list. The strings here follow the private/shared
 * workspace spec (sections 2.3-2.4, 8.3 and 17): the sidebar always shows the user-facing state of
 * `My draft` instead of internal workflow terminology.
 */

type PrivateWorkspaceLike = Pick<Workspace, 'linkedTeamWorkspaceId' | 'publicationStatus'>;

type SharedWorkspaceLike = Pick<
  Workspace,
  'publicationStatus' | 'currentPublishedVersionNumber' | 'pendingProposalCount'
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
  if (!workspace?.linkedTeamWorkspaceId) return UNLINKED_PRIVATE_LABEL;
  switch (workspace.publicationStatus) {
    case 'changes_to_publish':
      return 'My draft · Private changes';
    case 'team_updates_available':
      return 'My draft · Shared changed';
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
  if (workspace.publicationStatus === 'withdrawn') return 'No current locked version';
  const versionNumber = workspace.currentPublishedVersionNumber;
  if (versionNumber == null) return 'Working version';
  if (workspace.publicationStatus === 'changes_to_publish') {
    return versionNumber > 0
      ? `Locked v${versionNumber} · Changes not locked`
      : 'Changes not locked';
  }
  return `Locked v${versionNumber}`;
};

/** Publication state plus the pending-proposal count shown on the Shared workspace row. */
export const getSharedWorkspaceStatusDetails = (workspace: SharedWorkspaceLike): string => {
  const proposalCount = Number(workspace.pendingProposalCount || 0);
  return [
    getSharedWorkspacePublicationLabel(workspace),
    proposalCount ? `${proposalCount} proposal${proposalCount > 1 ? 's' : ''} pending` : null,
  ].filter(Boolean).join(' · ');
};
