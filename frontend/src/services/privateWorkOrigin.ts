/**
 * Private-work origin (Release B, F7 "Work privately" return path).
 *
 * When a user starts working privately from a Shared thread, we remember where
 * they came from — the origin Shared workspace, the thread, and the linked
 * proposal object — so the private working context can show a "Return to
 * thread / submit selected changes" affordance that navigates back to the exact
 * Shared workspace + proposal.
 *
 * Design mirrors teamThreadAssociation: a globalThis-pinned singleton with a
 * referentially-stable snapshot for useSyncExternalStore, scoped to the current
 * user (read from the A-owned authStore; never edited), cleared on sign-out /
 * lost access. It is persisted to sessionStorage so a normal reload inside the
 * private copy still offers the return path, and keyed by the PRIVATE workspace
 * id so opening an unrelated workspace shows nothing.
 */
import { getAuthUser } from '../auth/authStore';

export interface PrivateWorkOrigin {
  /** The user this origin belongs to (never inherited by another identity). */
  userId: string;
  /** The private working-copy workspace the user was sent into. */
  privateWorkspaceId: string;
  /** The origin Shared workspace to return to. */
  originWorkspaceId: string;
  /** The origin thread. */
  threadId: string;
  threadTitle: string;
  /** The linked proposal object to open on return (author submit panel). */
  proposalId: string;
}

interface OriginStore {
  origins: Map<string, PrivateWorkOrigin>; // key: privateWorkspaceId
  listeners: Set<() => void>;
  snapshots: Map<string, PrivateWorkOrigin | null>;
}

const STORE_KEY = Symbol.for('helpudoc.privateWorkOrigin');
const SESSION_KEY = 'helpudoc-private-work-origins';
const AUTH_STORAGE_KEY = 'helpudoc-auth-user';

function loadFromSession(): Map<string, PrivateWorkOrigin> {
  if (typeof window === 'undefined' || !window.sessionStorage) return new Map();
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as PrivateWorkOrigin[];
    return new Map(parsed.filter((o) => o && o.privateWorkspaceId).map((o) => [o.privateWorkspaceId, o]));
  } catch {
    return new Map();
  }
}

function store(): OriginStore {
  const g = globalThis as unknown as Record<symbol, OriginStore | undefined>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { origins: loadFromSession(), listeners: new Set(), snapshots: new Map() };
  }
  const s = g[STORE_KEY] as OriginStore;
  if (!s.snapshots) s.snapshots = new Map();
  return s;
}

function persist() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(Array.from(store().origins.values())));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function emit() {
  for (const listener of store().listeners) listener();
}

function currentUserId(): string | null {
  return getAuthUser()?.id ?? null;
}

/** Record an origin for a private working copy. */
export function setPrivateWorkOrigin(origin: Omit<PrivateWorkOrigin, 'userId'>): void {
  const userId = currentUserId();
  if (!userId) return;
  store().origins.set(origin.privateWorkspaceId, { ...origin, userId });
  persist();
  emit();
}

/** The origin for a given workspace id (only for the current user). */
export function getPrivateWorkOrigin(workspaceId: string | null | undefined): PrivateWorkOrigin | null {
  if (!workspaceId) return null;
  const userId = currentUserId();
  const origin = store().origins.get(workspaceId) ?? null;
  if (!origin || !userId || origin.userId !== userId) return null;
  return origin;
}

/** Referentially-stable snapshot for useSyncExternalStore. */
export function getPrivateWorkOriginSnapshot(workspaceId: string | null | undefined): PrivateWorkOrigin | null {
  const value = getPrivateWorkOrigin(workspaceId);
  const key = workspaceId || '';
  const cache = store().snapshots;
  const prev = cache.get(key) ?? null;
  if (!value) {
    if (prev !== null) cache.delete(key);
    return null;
  }
  if (
    prev &&
    prev.userId === value.userId &&
    prev.privateWorkspaceId === value.privateWorkspaceId &&
    prev.originWorkspaceId === value.originWorkspaceId &&
    prev.threadId === value.threadId &&
    prev.threadTitle === value.threadTitle &&
    prev.proposalId === value.proposalId
  ) {
    return prev;
  }
  cache.set(key, value);
  return value;
}

/** Clear one workspace's origin (e.g. after returning). */
export function clearPrivateWorkOrigin(workspaceId: string): void {
  const s = store();
  const had = s.origins.delete(workspaceId);
  s.snapshots.delete(workspaceId);
  if (had) {
    persist();
    emit();
  }
}

/** Clear ALL origins — call on sign-out / lost access. Also purges cached
 *  snapshots so a later same-user login cannot resurrect a stale snapshot. */
export function clearAllPrivateWorkOrigins(): void {
  const s = store();
  s.snapshots.clear();
  if (s.origins.size === 0) return;
  s.origins.clear();
  persist();
  emit();
}

export function subscribePrivateWorkOrigin(listener: () => void): () => void {
  store().listeners.add(listener);
  return () => {
    store().listeners.delete(listener);
  };
}

// Same-tab sign-out / account switch: authStore fires `helpudoc-auth-changed`
// (the native `storage` event does NOT fire in the tab that made the change).
// Clear origins that no longer belong to the current identity so a private
// context with no TeamChatPanel mounted still drops stale return targets.
if (typeof window !== 'undefined') {
  window.addEventListener('helpudoc-auth-changed', (event) => {
    const detail = (event as CustomEvent<{ userId?: string | null }>).detail;
    const nextUserId = detail?.userId ?? null;
    if (!nextUserId) {
      clearAllPrivateWorkOrigins();
      return;
    }
    let changed = false;
    const s = store();
    for (const [key, origin] of Array.from(s.origins.entries())) {
      if (origin.userId !== nextUserId) {
        s.origins.delete(key);
        s.snapshots.delete(key);
        changed = true;
      }
    }
    if (changed) {
      persist();
      emit();
    }
  });
}

// Sign-out / identity-change safety (cross-tab), mirroring the association store.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_STORAGE_KEY) return;
    if (!event.newValue) {
      clearAllPrivateWorkOrigins();
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue) as { id?: string };
      // If the signed-in identity changed, drop origins that belong to others.
      let changed = false;
      for (const [key, origin] of Array.from(store().origins.entries())) {
        if (origin.userId !== parsed.id) {
          store().origins.delete(key);
          changed = true;
        }
      }
      if (changed) {
        persist();
        emit();
      }
    } catch {
      clearAllPrivateWorkOrigins();
    }
  });
}
