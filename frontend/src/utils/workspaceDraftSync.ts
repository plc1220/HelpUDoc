import type { Workspace } from '../types';

/**
 * Draft sync statuses that require an explicit contributor action before a submission can be
 * applied to the Shared Working version. See the private/shared workspace spec, section 9.
 */
export const DRAFT_SYNC_ACTIONABLE_STATUSES = ['team_updates_available', 'review_needed'] as const;

export type DraftSyncActionableStatus = (typeof DRAFT_SYNC_ACTIONABLE_STATUSES)[number];

/**
 * `My draft` is a private workspace linked to one Shared workspace. Sync is only meaningful
 * for those, and only while the Shared Working version has moved ahead of the draft base.
 */
export const isLinkedDraftWorkspace = (workspace: Pick<Workspace, 'visibility' | 'linkedTeamWorkspaceId'> | null | undefined): boolean =>
  Boolean(workspace && workspace.visibility !== 'team' && workspace.linkedTeamWorkspaceId);

export const isDraftSyncActionable = (
  workspace: Pick<Workspace, 'visibility' | 'linkedTeamWorkspaceId' | 'publicationStatus'> | null | undefined,
): boolean => {
  if (!isLinkedDraftWorkspace(workspace)) return false;
  return DRAFT_SYNC_ACTIONABLE_STATUSES.includes(
    workspace?.publicationStatus as DraftSyncActionableStatus,
  );
};

/** Spec section 17 maps the internal `rebase` concept to the user-facing `Sync latest`. */
export const DRAFT_SYNC_ACTION_LABEL = 'Sync latest';

/** Spec section 8.3: the primary action for a draft holding private changes. */
export const DRAFT_REVIEW_CHANGES_ACTION_LABEL = 'Review changes';

/**
 * `Review changes` is the primary action for the `Private changes` draft state (spec section 8.3),
 * which is where the contributor inspects the diff and decides what to submit. It is only offered
 * on a linked private draft — never on the Shared workspace itself.
 */
export const isDraftReviewChangesActionable = (
  workspace: Pick<Workspace, 'visibility' | 'linkedTeamWorkspaceId' | 'publicationStatus'> | null | undefined,
): boolean => isLinkedDraftWorkspace(workspace) && workspace?.publicationStatus === 'changes_to_publish';

/**
 * Extract the conflict list from a failed sync attempt. The backend answers a sync that has
 * unresolved overlaps with HTTP 409 and `details.conflicts`, which drives `Resolve changes`.
 */
export const extractSyncConflicts = (details: unknown): Array<{ path: string }> => {
  if (!details || typeof details !== 'object') return [];
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter(
    (conflict): conflict is { path: string } => Boolean(conflict)
      && typeof conflict === 'object'
      && typeof (conflict as { path?: unknown }).path === 'string',
  );
};
