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

/**
 * Shared workspaces use reversible lifecycle actions. They are never hard-deleted from the UI.
 * Owners control sharing/trash; members may only leave their own membership.
 */
export const getSharedWorkspaceLifecycleActions = (
  workspace: Pick<Workspace, 'visibility' | 'role' | 'status' | 'audienceType'>,
): WorkspaceLifecycleAction[] => {
  if (workspace.visibility !== 'team') return [];
  const status = getWorkspaceLifecycleStatus(workspace);
  const isOwner = workspace.role === 'owner';
  if (isOwner) {
    if (status === 'trashed') return ['restore'];
    if (status === 'unshared') return ['reshare', 'trash'];
    return ['unshare', 'trash'];
  }
  // Team-derived access is governed by Team membership; deleting only a
  // direct workspace grant would not actually make the user leave.
  return workspace.role && status !== 'trashed' && workspace.audienceType !== 'team' ? ['leave'] : [];
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
