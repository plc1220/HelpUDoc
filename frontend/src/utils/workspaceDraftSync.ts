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
 * Extract the conflict list from an autosync HTTP conflict. Manual sync returns
 * the same conflicts in a normal `review_needed` result.
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

/**
 * What a sync just pulled into the draft.
 *
 * A sync rewrites the user's files. Saying only that it happened leaves them
 * unable to tell an incoming change from their own work disappearing, so the
 * message names the files when the backend reported them. Three paths are
 * listed in full; beyond that the count carries it.
 */
export const describeSyncedFiles = (syncedFiles: string[] | undefined): string => {
  const paths = (syncedFiles || []).filter(Boolean);
  if (!paths.length) return '';
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
};

/** The one-line result of a sync, used by both the manual and automatic paths. */
export const buildSyncSummary = (workspaceName: string, syncedFiles: string[] | undefined): string => {
  const described = describeSyncedFiles(syncedFiles);
  const count = (syncedFiles || []).length;
  if (!count) return `Synced the latest Shared Working version into ${workspaceName}.`;
  return `Synced ${count} ${count === 1 ? 'file' : 'files'} from the Shared workspace into `
    + `${workspaceName}: ${described}.`;
};
