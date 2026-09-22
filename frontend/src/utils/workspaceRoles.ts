import type { Workspace } from '../types';

/**
 * Role predicates shared by the sidebar, the workspace header and the review
 * queue.
 *
 * These lived as module-local `const`s in `WorkspaceCollaborationDialog`, and
 * `WorkspaceList` carried a second copy of `roleCanPropose` spelled out inline.
 * Two copies of an authorization rule drift, and the sidebar is the one place a
 * drift is invisible — it shows an action the server then refuses.
 *
 * These mirror `backend/src/services/workspaceCollaborationPolicy.ts`, which
 * cannot be imported here because it lives outside the shared contracts package.
 * The backend remains the authority; these only decide what to draw.
 */

type WorkspaceRole = Workspace['role'];

/** Commenter and above may join a discussion. */
export const roleCanComment = (role: WorkspaceRole): boolean => (
  role === 'owner' || role === 'editor' || role === 'contributor' || role === 'commenter'
);

/**
 * Contributor and above may submit changes for review. A viewer has nowhere to
 * take a copy, so offering one would dead-end them.
 */
export const roleCanPropose = (role: WorkspaceRole): boolean => (
  role === 'owner' || role === 'editor' || role === 'contributor'
);

/**
 * Owner and Publisher may approve and apply submitted changes.
 *
 * This is the gate for every "changes for review" cue. A contributor can submit
 * but cannot approve, so showing them a review prompt sends them somewhere they
 * have no button — the same dead end `roleCanPropose` avoids for viewers.
 */
export const roleCanModerate = (role: WorkspaceRole): boolean => (
  role === 'owner' || role === 'editor'
);
