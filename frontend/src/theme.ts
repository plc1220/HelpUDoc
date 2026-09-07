import { createTheme, type PaletteMode } from '@mui/material/styles';

export {
  APP_COLOR_MODE_CHANGE_EVENT,
  APP_COLOR_MODE_STORAGE_KEY,
  applyColorModeToDocument,
  resolveInitialColorMode,
} from './colorMode';

/**
 * Compatibility theme for the MUI screens that have not yet moved to Astryx —
 * the workspace drawer, the collapsed rail, and the workspace dialogs.
 *
 * The values are a hand-copy of the SKP theme's tokens, and that is a known
 * cost: MUI resolves its palette in JS at theme-build time, so it cannot read
 * `var(--color-*)` and have `alpha()` or `getContrastText()` work on the
 * result. Keep this list in step with `src/themes/skp.ts` when the palette
 * moves. Astryx remains the theme owner; this only exists so MUI surfaces do
 * not sit next to Astryx panes in a different colour.
 */
const skp = {
  light: {
    background: '#eef2f7',
    surface: '#ffffff',
    textPrimary: '#14263b',
    textSecondary: '#5b6b7f',
    divider: '#e4e9f0',
    accent: '#0b5fd4',
    accentDark: '#0b4fb0',
    secondary: '#00968f',
    error: '#c0563f',
    warning: '#e0a92e',
    success: '#3a9e6b',
  },
  dark: {
    background: '#0f172a',
    surface: '#18212f',
    textPrimary: '#f1f5f9',
    textSecondary: '#8b9bb3',
    divider: '#26324a',
    accent: '#3b82f6',
    accentDark: '#94c5f8',
    secondary: '#22c1b6',
    error: '#e2735a',
    warning: '#f2c00b',
    success: '#4bb87f',
  },
} as const;

export const buildAppTheme = (mode: PaletteMode) => {
  const c = skp[mode];

  return createTheme({
    palette: {
      mode,
      primary: { main: c.accent, dark: c.accentDark, contrastText: '#ffffff' },
      secondary: { main: c.secondary, contrastText: '#ffffff' },
      error: { main: c.error },
      warning: { main: c.warning },
      success: { main: c.success },
      background: { default: c.background, paper: c.surface },
      text: { primary: c.textPrimary, secondary: c.textSecondary },
      divider: c.divider,
    },
    shape: { borderRadius: 8 },
    typography: {
      // Matches --font-family-body. "Variable" is the family name
      // @fontsource-variable/public-sans registers; the static name follows it
      // so a system-installed copy still wins over the platform sans.
      fontFamily:
        '"Public Sans Variable", "Public Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      button: { textTransform: 'none', fontWeight: 600 },
    },
    components: {
      MuiDrawer: {
        styleOverrides: { paper: { backgroundColor: c.surface } },
      },
      MuiPaper: {
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiButton: {
        styleOverrides: { root: { borderRadius: 8, textTransform: 'none' } },
      },
      MuiTextField: {
        styleOverrides: {
          root: { '& .MuiOutlinedInput-root': { borderRadius: 8 } },
        },
      },
    },
  });
};
