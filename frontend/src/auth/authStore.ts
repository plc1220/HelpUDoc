export type AuthUser = {
  id: string;
  name: string;
  email?: string | null;
  provider?: 'google' | 'local';
  avatarUrl?: string | null;
};

const STORAGE_KEY = 'helpudoc-auth-user';

let cachedUser: AuthUser | null = null;

const isBrowser = typeof window !== 'undefined';

function loadFromStorage(): AuthUser | null {
  if (!isBrowser || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.id && parsed.name) {
      return parsed as AuthUser;
    }
  } catch (error) {
    console.warn('Failed to restore auth user from storage', error);
  }
  return null;
}

export function getAuthUser(): AuthUser | null {
  if (cachedUser) return cachedUser;
  cachedUser = loadFromStorage();
  return cachedUser;
}

export function setAuthUser(user: AuthUser | null): void {
  const previous = cachedUser;
  cachedUser = user;
  if (!isBrowser || !window.localStorage) {
    return;
  }
  try {
    if (user) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Failed to persist auth user', error);
  }
  // Notify same-tab listeners of a sign-out or account switch. The native
  // `storage` event does NOT fire in the tab that made the change, so features
  // that must clear per-user in-memory state (Team Chat thread drafts, thread
  // associations) rely on this explicit event (Release A spec: drafts clear on
  // sign-out / lost access; team-chat-threads-spec §F2/F5).
  const changed = (previous?.id ?? null) !== (user?.id ?? null);
  if (changed && isBrowser) {
    try {
      window.dispatchEvent(
        new CustomEvent('helpudoc-auth-changed', {
          detail: { previousUserId: previous?.id ?? null, userId: user?.id ?? null },
        }),
      );
    } catch {
      /* ignore environments without CustomEvent */
    }
  }
}
