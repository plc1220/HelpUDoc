/**
 * Explicit "attribute my future edits to this thread" association (Release B,
 * F6 provenance).
 *
 * WHY THIS EXISTS / OWNERSHIP: The spec requires human file edits to be
 * attributed to a thread ONLY when the editor explicitly carries an active
 * thread association, applied to FUTURE operations, visible in editor/workspace
 * controls, scoped per user + workspace, and CLEARED on sign-out / lost access.
 * Merely opening a thread must never silently reattribute edits, and there is
 * no retroactive association.
 *
 * It is a NEW module owned by the Release B frontend session. It reads the
 * current user id from the A-owned `authStore` (import only — never edits it)
 * and clears the association when that stored identity changes or disappears
 * (sign-out / switched user) by listening to the `storage` event that
 * `authStore.setAuthUser` triggers cross-tab, plus an explicit
 * {@link clearThreadAssociation} the app calls on access loss.
 *
 * The association lives in memory only (never persisted). A page reload starts
 * with NO association, so edits default to unattributed — the safe default that
 * never leaks a stale attribution.
 */
import { getAuthUser } from '../auth/authStore';

interface Association {
  userId: string;
  workspaceId: string;
  threadId: string;
  threadTitle: string;
}

/**
 * Single source of truth for the association + subscribers, pinned to a
 * `globalThis` symbol. This guarantees ONE shared state even if the module is
 * evaluated more than once (HMR, or a test harness importing raw `/src` and an
 * optimized dep copy of the same file). In the production bundle there is a
 * single module graph, so this is simply a hardening measure.
 */
interface AssociationStore {
  current: Association | null;
  listeners: Set<() => void>;
  /** Cached stable snapshot per workspace so `useSyncExternalStore` never sees a
   *  new object identity unless the underlying value actually changed. */
  snapshots: Map<string, ThreadAssociationSnapshot>;
}

export interface ThreadAssociationSnapshot {
  threadId: string;
  threadTitle: string;
}

const STORE_KEY = Symbol.for('helpudoc.teamThreadAssociation');

function store(): AssociationStore {
  const g = globalThis as unknown as Record<symbol, AssociationStore | undefined>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { current: null, listeners: new Set(), snapshots: new Map() };
  }
  const s = g[STORE_KEY] as AssociationStore;
  // Hardening: an older evaluation may lack `snapshots`.
  if (!s.snapshots) s.snapshots = new Map();
  return s;
}

const AUTH_STORAGE_KEY = 'helpudoc-auth-user';

function emit() {
  for (const listener of store().listeners) listener();
}

function currentUserId(): string | null {
  return getAuthUser()?.id ?? null;
}

/** True when there is an active association for this user + workspace. */
export function getThreadAssociation(workspaceId: string): {
  threadId: string;
  threadTitle: string;
} | null {
  const userId = currentUserId();
  const current = store().current;
  if (!current || !userId) return null;
  // Defensive: an association only applies to the exact user + workspace that
  // set it. A different signed-in identity never inherits it.
  if (current.userId !== userId || current.workspaceId !== workspaceId) return null;
  return { threadId: current.threadId, threadTitle: current.threadTitle };
}

/**
 * Referentially-STABLE snapshot for `useSyncExternalStore` (Release B review:
 * `getThreadAssociation` returns a fresh object each call, which loops
 * useSyncExternalStore). This returns the SAME object reference until the
 * effective association for `workspaceId` actually changes (threadId/title), and
 * a stable `null` when there is none. Pair with {@link subscribeThreadAssociation}.
 */
export function getThreadAssociationSnapshot(
  workspaceId: string,
): ThreadAssociationSnapshot | null {
  const value = getThreadAssociation(workspaceId);
  const cache = store().snapshots;
  const prev = cache.get(workspaceId) ?? null;
  if (!value) {
    if (prev !== null) cache.delete(workspaceId);
    return null;
  }
  if (prev && prev.threadId === value.threadId && prev.threadTitle === value.threadTitle) {
    return prev; // stable identity — nothing changed
  }
  const next: ThreadAssociationSnapshot = { threadId: value.threadId, threadTitle: value.threadTitle };
  cache.set(workspaceId, next);
  return next;
}

/** The thread id to send with a mutating file op for `workspaceId`, or
 *  undefined when there is no active association (unattributed edit). */
export function getAssociatedThreadId(workspaceId: string): string | undefined {
  return getThreadAssociation(workspaceId)?.threadId;
}

/** Explicitly attribute this user's FUTURE edits in `workspaceId` to a thread. */
export function setThreadAssociation(
  workspaceId: string,
  threadId: string,
  threadTitle: string,
): void {
  const userId = currentUserId();
  if (!userId) return; // No identity → refuse to attribute (fail safe).
  store().current = { userId, workspaceId, threadId, threadTitle };
  emit();
}

/** Clear any active association. Call on sign-out or lost workspace access. */
export function clearThreadAssociation(): void {
  if (store().current === null) return;
  store().current = null;
  emit();
}

/** Subscribe to association changes (for React `useSyncExternalStore`). */
export function subscribeThreadAssociation(listener: () => void): () => void {
  store().listeners.add(listener);
  return () => {
    store().listeners.delete(listener);
  };
}

// Cross-tab / sign-out safety: clear the association whenever the stored auth
// identity is removed or changes to a different user. This reacts to
// authStore.setAuthUser writes WITHOUT importing or editing that A-owned module
// beyond the allowed `getAuthUser` read.
if (typeof window !== 'undefined') {
  // Same-tab sign-out / account switch (native `storage` does not fire in the
  // originating tab).
  window.addEventListener('helpudoc-auth-changed', (event) => {
    const detail = (event as CustomEvent<{ userId?: string | null }>).detail;
    const nextUserId = detail?.userId ?? null;
    const current = store().current;
    if (!nextUserId || (current && current.userId !== nextUserId)) {
      clearThreadAssociation();
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_STORAGE_KEY) return;
    if (!event.newValue) {
      clearThreadAssociation();
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue) as { id?: string };
      if (store().current && parsed.id !== store().current!.userId) {
        clearThreadAssociation();
      }
    } catch {
      clearThreadAssociation();
    }
  });
}
