import type { PaletteMode } from '@mui/material';

export const APP_COLOR_MODE_STORAGE_KEY = 'helpudoc-color-mode';

export const resolveInitialColorMode = (): PaletteMode => {
  if (typeof window === 'undefined') {
    return 'light';
  }

  const stored = window.localStorage.getItem(APP_COLOR_MODE_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyColorModeToDocument = (mode: PaletteMode) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(APP_COLOR_MODE_STORAGE_KEY, mode);
  }
};
