import type { Workspace, WorkspaceLifecycleAction } from '../types';
export type { WorkspaceLifecycleAction } from '../types';

export const WORKSPACE_LIFECYCLE_ACTION_LABELS: Record<WorkspaceLifecycleAction, string> = {
  unshare: 'Unshare',
  reshare: 'Re-share',
  trash: 'Move to trash',
  restore: 'Restore',
  leave: 'Leave workspace',
  reconnect: 'Reconnect to Shared workspace',
};

export const getWorkspaceLifecycleStatus = (
  workspace: Pick<Workspace, 'status'> | null | undefined,
): NonNullable<Workspace['status']> => {
  const rawStatus = String(workspace?.status || 'active');
  // `archived` was the pre-lifecycle name for an unshared Shared workspace.
  if (rawStatus === 'archived') return 'unshared';
  if (rawStatus === 'unshared' || rawStatus === 'trashed') return rawStatus;
  return 'active';
};

/** An unshared Shared workspace is owner-only in the navigator, but remains reversible. */
export const isOwnerOnlyUnsharedWorkspace = (
  workspace: Pick<Workspace, 'visibility' | 'status'> | null | undefined,
): boolean => workspace?.visibility === 'team' && getWorkspaceLifecycleStatus(workspace) === 'unshared';

/**
 * Shared workspaces use reversible lifecycle actions. They are never hard-deleted from the UI.
 * Owners control sharing/trash; members may only leave their own membership.
 */
export const getSharedWorkspaceLifecycleActions = (
  workspace: Pick<Workspace, 'visibility' | 'role' | 'status' | 'canLeave'>,
): WorkspaceLifecycleAction[] => {
  if (workspace.visibility !== 'team') return [];
  const status = getWorkspaceLifecycleStatus(workspace);
  const isOwner = workspace.role === 'owner';
  if (isOwner) {
    if (status === 'trashed') return ['restore'];
    if (status === 'unshared') return ['reshare', 'trash'];
    return ['unshare', 'trash'];
  }
  // The server answers this, with the same rule the leave endpoint enforces:
  // team-derived access is governed by Team membership, so deleting only a
  // direct grant would not actually make the user leave. Absent means no, which
  // keeps a stale payload from offering an action that will be refused.
  // The trashed check is local UI logic, not a second copy of the leave rule:
  // a trashed row offers restore or nothing, and the owner branch above already
  // covers restore.
  return status !== 'trashed' && workspace.canLeave ? ['leave'] : [];
};

/**
 * Autosync is intentionally narrower than the manual Sync latest action: it runs only on an
 * explicit open of an active private draft whose linked Shared workspace is also active.
 */
export const isLinkedDraftAutoSyncEligible = (
  workspace: Pick<
    Workspace,
    'id' | 'visibility' | 'linkedTeamWorkspaceId' | 'publicationStatus' | 'status'
  > | null | undefined,
  allWorkspaces: Array<Pick<Workspace, 'id' | 'visibility' | 'status'>>,
): boolean => {
  if (!workspace || workspace.visibility === 'team') return false;
  if (getWorkspaceLifecycleStatus(workspace) !== 'active') return false;
  if (
    !workspace.linkedTeamWorkspaceId
    || !['team_updates_available', 'review_needed'].includes(String(workspace.publicationStatus || ''))
  ) {
    return false;
  }
  const linkedShared = allWorkspaces.find((candidate) => (
    candidate.id === workspace.linkedTeamWorkspaceId && candidate.visibility === 'team'
  ));
  return Boolean(linkedShared && getWorkspaceLifecycleStatus(linkedShared) === 'active');
};
