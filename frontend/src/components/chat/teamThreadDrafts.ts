import type { ComposerToken } from './teamComposer';

/**
 * In-memory, per-(user, workspace, thread) draft store for Team Chat threads
 * (spec F2). Drafts are intentionally NOT persisted to localStorage — Release A
 * keeps them in memory for the lifetime of the open workspace only, and clears
 * them on sign-out or lost access. There is deliberately no workspace-wide
 * singleton: every draft is scoped by the composite key below so one thread's
 * unsent text/references/quote can never leak into another thread, workspace,
 * or user session.
 *
 * The reserved thread id `NEW_THREAD_DRAFT_ID` holds the "New thread" composer
 * draft (title + body) separately from any real thread.
 */

export const NEW_THREAD_DRAFT_ID = '__new_thread__';

export interface TeamThreadDraft {
  /** Composer body text (raw, with reference tokens inline). */
  text: string;
  /**
   * Exact composer tokens (position + reference identity/version). Stored
   * structurally rather than as a plain reference list so restoration never
   * reassigns a reference to same-labelled plain text or confuses two files
   * that share a display name.
   */
  tokens: ComposerToken[];
  /** Optional new-thread title (only meaningful for NEW_THREAD_DRAFT_ID). */
  title?: string;
  /** Optional quoted reply target message id within the thread. */
  replyToMessageId?: string;
  /**
   * Stable idempotency key retained across retries of the SAME send attempt so
   * a failed OR unknown/pending send retried after reconnect cannot create a
   * duplicate (spec §5.2, A02/A06). Regenerated only for a genuinely new
   * attempt (intentional payload change).
   */
  clientMessageId?: string;
  /**
   * Attempt lifecycle:
   *  - undefined/'editing': an unsent draft the user is composing.
   *  - 'pending': a send is in flight; its outcome is not yet known. A retry of
   *    this exact attempt MUST reuse `clientMessageId` (the server dedupes), so
   *    a committed-but-unacknowledged send is never duplicated.
   *  - 'failed': a send failed; retry reuses `clientMessageId`.
   */
  status?: 'editing' | 'pending' | 'failed';
  /**
   * @deprecated use `status`. Kept as a derived convenience: true when the last
   * attempt failed. Callers should prefer `status`.
   */
  failed?: boolean;
}

type DraftKey = string;

const makeKey = (userId: string, workspaceId: string, threadId: string): DraftKey =>
  `${userId}\u0000${workspaceId}\u0000${threadId}`;

const store = new Map<DraftKey, TeamThreadDraft>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const subscribeThreadDrafts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getThreadDraft = (
  userId: string,
  workspaceId: string,
  threadId: string,
): TeamThreadDraft | undefined => store.get(makeKey(userId, workspaceId, threadId));

export const setThreadDraft = (
  userId: string,
  workspaceId: string,
  threadId: string,
  draft: TeamThreadDraft | undefined,
): void => {
  const key = makeKey(userId, workspaceId, threadId);
  const isEmpty =
    !draft ||
    (!draft.text.trim() &&
      !(draft.tokens && draft.tokens.length) &&
      !(draft.title && draft.title.trim()) &&
      !draft.replyToMessageId &&
      !draft.failed &&
      draft.status !== 'pending' &&
      draft.status !== 'failed');
  if (isEmpty) {
    if (store.delete(key)) emit();
    return;
  }
  store.set(key, draft);
  emit();
};

export const clearThreadDraft = (
  userId: string,
  workspaceId: string,
  threadId: string,
): void => {
  if (store.delete(makeKey(userId, workspaceId, threadId))) emit();
};

/**
 * Clear a draft ONLY if the stored entry still belongs to the given attempt
 * (same clientMessageId). This lets a late-completing send clear its own draft
 * even after the UI unmounted, WITHOUT clobbering a newer draft the user
 * started for the same thread in the meantime (lifecycle review #1/#2).
 */
export const clearThreadDraftIfAttemptOwned = (
  userId: string,
  workspaceId: string,
  threadId: string,
  clientMessageId: string,
): void => {
  const key = makeKey(userId, workspaceId, threadId);
  const existing = store.get(key);
  if (existing && existing.clientMessageId === clientMessageId) {
    store.delete(key);
    emit();
  }
};

/**
 * Mark a draft failed ONLY if the stored entry still belongs to the given
 * attempt. A late failure after the user navigated away / signed out must not
 * resurrect a draft that a newer attempt or a sign-out already replaced/cleared
 * (lifecycle review #2).
 */
export const markThreadDraftFailedIfOwned = (
  userId: string,
  workspaceId: string,
  threadId: string,
  clientMessageId: string,
): void => {
  const key = makeKey(userId, workspaceId, threadId);
  const existing = store.get(key);
  if (existing && existing.clientMessageId === clientMessageId) {
    store.set(key, { ...existing, status: 'failed', failed: true });
    emit();
  }
};

/** Clear every draft for a user (sign-out / lost access at the account level). */
export const clearUserThreadDrafts = (userId: string): void => {
  let changed = false;
  const prefix = `${userId}\u0000`;
  for (const key of Array.from(store.keys())) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) emit();
};

/**
 * Clear every draft for a specific (user, workspace) pair. Used when access to
 * a single workspace is lost while other workspaces remain accessible.
 */
export const clearWorkspaceThreadDrafts = (userId: string, workspaceId: string): void => {
  let changed = false;
  const prefix = `${userId}\u0000${workspaceId}\u0000`;
  for (const key of Array.from(store.keys())) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) emit();
};

/** Test-only: wipe the entire store. */
export const __resetThreadDraftsForTest = (): void => {
  store.clear();
  emit();
};

// --- Auth lifecycle: clear per-user in-memory drafts on sign-out / switch ----
// `authStore.setAuthUser` dispatches `helpudoc-auth-changed` in the SAME tab
// (the native `storage` event does not fire in the writing tab). We clear the
// PREVIOUS user's drafts (or all drafts on a full sign-out) so no unsent text
// survives a session change (spec F2/F5). We also coordinate the Release B
// thread-association clear via a lazy import so we neither edit nor statically
// depend on that B-owned module.
if (typeof window !== 'undefined') {
  window.addEventListener('helpudoc-auth-changed', (event) => {
    const detail = (event as CustomEvent).detail as { previousUserId?: string | null; userId?: string | null } | undefined;
    const previousUserId = detail?.previousUserId ?? null;
    if (previousUserId) {
      clearUserThreadDrafts(previousUserId);
    } else {
      // Unknown previous identity: clear everything to fail safe.
      store.clear();
      emit();
    }
    // Coordinate the B-owned association clear without editing it.
    void import('../../services/teamThreadAssociation')
      .then((mod) => mod.clearThreadAssociation?.())
      .catch(() => undefined);
  });
}
