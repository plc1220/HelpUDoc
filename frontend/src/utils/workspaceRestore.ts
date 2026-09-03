import type { Workspace } from '../types';
// Explicit extension so `node --test --experimental-strip-types` can resolve this
// value import, matching `workspaceHtmlPreview.ts`.
import { getWorkspaceLifecycleStatus } from './workspaceLifecycle.ts';

/**
 * Resolve a stored last-workspace id against the list the server just returned for
 * this user.
 *
 * The stored id is unverified and allowed to dangle — the column carries no foreign
 * key by design — so this is the single point that decides whether it may be acted
 * on. Returning `null` is the graceful fallback in every failure case, and it lands
 * the user on exactly the landing page a first-time user sees.
 *
 * `trashed` is the only lifecycle status excluded, mirroring the sidebar's own
 * openability rule in `WorkspaceList.tsx` (`disabled={lifecycleStatus === 'trashed'}`).
 * An `unshared` workspace is still restorable: the backend only lists one for its
 * owner, who can still open it by clicking.
 */
export const resolveWorkspaceToRestore = (
  workspaces: Workspace[],
  storedWorkspaceId: string | null | undefined,
): Workspace | null => {
  const id = typeof storedWorkspaceId === 'string' ? storedWorkspaceId.trim() : '';
  // An empty string is not a missing value to `??`, and these stringified forms are
  // what a bad round-trip actually produces.
  if (!id || id === 'undefined' || id === 'null') {
    return null;
  }
  const match = workspaces.find((workspace) => workspace.id === id);
  // Absent from the list means deleted, purged, or access revoked.
  if (!match) {
    return null;
  }
  if (getWorkspaceLifecycleStatus(match) === 'trashed') {
    return null;
  }
  return match;
};

/**
 * Whether opening this workspace should be remembered as the user's last used one.
 *
 * Being selected is not enough: two paths deliberately select a workspace while
 * keeping the landing page up — `handleCreateWorkspace({ stayOnLanding: true })`, and
 * the landing picker when the chosen workspace has no conversations. In both the user
 * is still on the landing page and has not actually entered the workspace.
 */
export const shouldPersistWorkspaceOpen = (input: {
  workspaceId: string | null | undefined;
  isLandingPageVisible: boolean;
  alreadyPersistedId: string | null;
}): boolean => {
  const id = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
  if (!id || id === 'undefined' || id === 'null') {
    return false;
  }
  if (input.isLandingPageVisible) {
    return false;
  }
  return input.alreadyPersistedId !== id;
};
