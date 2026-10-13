/**
 * Keeps the chat message a user was about to send across a forced sign-in.
 *
 * Signing in again is a full-page redirect through Google, so component state is
 * gone when the user comes back. sessionStorage survives the redirect within the
 * same tab and is cleared when the tab closes, which is the lifetime we want.
 */
const STORAGE_KEY = 'helpudoc.composerDraft';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredDraft = { workspaceId: string; text: string; savedAt: number };

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const saveComposerDraft = (
  storage: DraftStorage | undefined,
  workspaceId: string | null | undefined,
  text: string,
  now = Date.now(),
): void => {
  if (!storage || !workspaceId || !text.trim()) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ workspaceId, text, savedAt: now } satisfies StoredDraft));
  } catch {
    // Storage can be full or blocked; losing the draft is the old behaviour.
  }
};

/** Returns the saved draft for this workspace once, then forgets it. */
export const takeComposerDraft = (
  storage: DraftStorage | undefined,
  workspaceId: string | null | undefined,
  now = Date.now(),
): string | null => {
  if (!storage || !workspaceId) return null;
  let draft: StoredDraft | null = null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    draft = raw ? JSON.parse(raw) as StoredDraft : null;
  } catch {
    draft = null;
  }
  if (!draft || draft.workspaceId !== workspaceId) return null;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: the age check below still stops it coming back forever.
  }
  if (typeof draft.text !== 'string' || !draft.text.trim() || now - Number(draft.savedAt) > MAX_AGE_MS) {
    return null;
  }
  return draft.text;
};

/** `window.sessionStorage` can throw when storage is blocked; treat that as absent. */
export const browserSessionStorage = (): DraftStorage | undefined => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
};
