import { useEffect, useState } from 'react';
import { createTheme, type PaletteMode } from '@mui/material/styles';

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

export const buildAppTheme = (mode: PaletteMode, uiTheme: UITheme = resolveInitialUITheme()) => {
  const isMinimalism = uiTheme === 'minimalism';
  const isBauhaus = uiTheme === 'bauhaus';

  // Customize palettes based on selected UI theme
  let primaryColor = mode === 'light' ? '#2563eb' : '#60a5fa';
  let defaultBg = mode === 'light' ? '#f8fafc' : '#0b1220';
  let paperBg = mode === 'light' ? '#ffffff' : '#0f172a';
  let textPrimary = mode === 'light' ? '#0f172a' : '#e2e8f0';
  let textSecondary = mode === 'light' ? '#475569' : '#cbd5e1';
  let dividerColor = mode === 'light' ? '#e2e8f0' : '#1f2937';
  let borderRadius = 12;

  if (isMinimalism) {
    primaryColor = mode === 'light' ? '#171717' : '#ffffff';
    defaultBg = mode === 'light' ? '#f5f5f5' : '#121212';
    paperBg = mode === 'light' ? '#ffffff' : '#1c1c1c';
    textPrimary = mode === 'light' ? '#171717' : '#f5f5f5';
    textSecondary = mode === 'light' ? '#525252' : '#a3a3a3';
    dividerColor = mode === 'light' ? '#e5e5e5' : '#262626';
    borderRadius = 9999; // Extreme minimalism uses rounded pill-like elements
  } else if (isBauhaus) {
    primaryColor = mode === 'light' ? '#d62828' : '#ff4d4d'; // Red
    defaultBg = mode === 'light' ? '#f3efe0' : '#111111'; // Cream
    paperBg = mode === 'light' ? '#ffffff' : '#1e1e1e';
    textPrimary = mode === 'light' ? '#000000' : '#ffffff';
    textSecondary = mode === 'light' ? '#000000' : '#cccccc';
    dividerColor = mode === 'light' ? '#000000' : '#ffffff';
    borderRadius = 0; // Bauhaus uses sharp boxy corners
  }

  return createTheme({
    palette: {
      mode,
      primary: {
        main: primaryColor,
      },
      background: {
        default: defaultBg,
        paper: paperBg,
      },
      text: {
        primary: textPrimary,
        secondary: textSecondary,
      },
      divider: dividerColor,
    },
    shape: {
      borderRadius,
    },
    typography: {
      fontFamily: isMinimalism ? 'Outfit, Inter, sans-serif' : isBauhaus ? '"Space Grotesk", "Courier New", monospace, sans-serif' : 'Inter, sans-serif',
      h1: {
        textTransform: isBauhaus ? 'uppercase' : 'none',
        fontWeight: isBauhaus ? 800 : isMinimalism ? 300 : 700,
      },
      h2: {
        textTransform: isBauhaus ? 'uppercase' : 'none',
        fontWeight: isBauhaus ? 800 : isMinimalism ? 300 : 700,
      },
      button: {
        textTransform: isBauhaus ? 'uppercase' : isMinimalism ? 'lowercase' : 'none',
        fontWeight: isBauhaus ? 800 : 500,
      }
    },
    components: {
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: defaultBg,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            ...(isBauhaus && {
              border: `2px solid ${dividerColor}`,
              boxShadow: mode === 'light' ? '4px 4px 0px #000000' : '4px 4px 0px #ffffff',
            }),
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius,
            textTransform: isBauhaus ? 'uppercase' : isMinimalism ? 'lowercase' : 'none',
            ...(isBauhaus && {
              border: `2px solid ${dividerColor}`,
              boxShadow: mode === 'light' ? '2px 2px 0px #000000' : '2px 2px 0px #ffffff',
              '&:hover': {
                boxShadow: 'none',
                transform: 'translate(2px, 2px)',
              }
            }),
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius,
              ...(isBauhaus && {
                '& fieldset': {
                  borderWidth: '2px !important',
                  borderColor: `${dividerColor} !important`,
                },
              }),
            },
          },
        },
      },
    },
  });
};
