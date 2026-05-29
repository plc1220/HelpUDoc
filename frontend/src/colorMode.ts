import { useEffect, useState } from 'react';
import type { PaletteMode } from '@mui/material';

export const APP_COLOR_MODE_STORAGE_KEY = 'helpudoc-color-mode';
export const APP_THEME_STORAGE_KEY = 'helpudoc-ui-theme';

export type UITheme = 'standard' | 'minimalism' | 'bauhaus';

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

export const resolveInitialUITheme = (): UITheme => {
  if (typeof window === 'undefined') {
    return 'standard';
  }
  const stored = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
  if (stored === 'standard' || stored === 'minimalism' || stored === 'bauhaus') {
    return stored as UITheme;
  }
  return 'standard';
};

export const applyUIThemeToDocument = (theme: UITheme) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-ui-theme', theme);
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
  }
};

export const useUITheme = () => {
  const [theme, setTheme] = useState<UITheme>(resolveInitialUITheme);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === APP_THEME_STORAGE_KEY) {
        const val = e.newValue as UITheme;
        if (val === 'standard' || val === 'minimalism' || val === 'bauhaus') {
          setTheme(val);
          applyUIThemeToDocument(val);
        }
      }
    };

    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<UITheme>;
      setTheme(customEvent.detail);
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('helpudoc-ui-theme-change', handleCustomEvent);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('helpudoc-ui-theme-change', handleCustomEvent);
    };
  }, []);

  const changeTheme = (newTheme: UITheme) => {
    setTheme(newTheme);
    applyUIThemeToDocument(newTheme);
    window.dispatchEvent(new CustomEvent('helpudoc-ui-theme-change', { detail: newTheme }));
  };

  return [theme, changeTheme] as const;
};
