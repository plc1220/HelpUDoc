import { useEffect } from 'react';

/**
 * Read a boolean stored by `useStoredBoolean`, for a `useState` initializer.
 *
 * The caller keeps its own `useState` so the setter stays a plain React setter,
 * which `react-hooks/exhaustive-deps` knows is stable.
 */
export const readStoredBoolean = (key: string, fallback: boolean) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
};

/**
 * Store *value* in localStorage under *storageKey* whenever it changes. Sign-out
 * removes only the auth key, so a layout choice outlives the session that made
 * it, like the pane widths in `useHorizontalPaneResize`.
 */
export function useStoredBoolean(storageKey: string, value: boolean) {
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // ignore storage errors
    }
  }, [storageKey, value]);
}
