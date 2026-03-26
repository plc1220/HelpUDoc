import { createTheme, type PaletteMode } from '@mui/material/styles';

export const APP_COLOR_MODE_STORAGE_KEY = 'helpudoc-color-mode';

export const resolveInitialColorMode = (): PaletteMode => {
  if (typeof window === 'undefined') {
    return 'light';
  }

  try {
    const stored = window.localStorage.getItem(APP_COLOR_MODE_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch (error) {
    console.warn('Failed to read persisted color mode', error);
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyColorModeToDocument = (mode: PaletteMode) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APP_COLOR_MODE_STORAGE_KEY, mode);
    } catch (error) {
      console.warn('Failed to persist color mode', error);
    }
  }
};

export const buildAppTheme = (mode: PaletteMode) =>
  createTheme({
    palette: {
      mode,
      primary: {
        main: mode === 'light' ? '#2563eb' : '#60a5fa',
      },
      background: {
        default: mode === 'light' ? '#f8fafc' : '#0b1220',
        paper: mode === 'light' ? '#ffffff' : '#0f172a',
      },
      text: {
        primary: mode === 'light' ? '#0f172a' : '#e2e8f0',
        secondary: mode === 'light' ? '#475569' : '#cbd5e1',
      },
      divider: mode === 'light' ? '#e2e8f0' : '#1f2937',
    },
    shape: {
      borderRadius: 12,
    },
    typography: {
      fontFamily: 'Inter, sans-serif',
    },
    components: {
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: mode === 'light' ? '#f8fafc' : '#0f172a',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            textTransform: 'none',
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 12,
            },
          },
        },
      },
    },
  });
