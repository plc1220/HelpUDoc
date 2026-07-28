import { createTheme, type PaletteMode } from '@mui/material/styles';

export {
  APP_COLOR_MODE_CHANGE_EVENT,
  APP_COLOR_MODE_STORAGE_KEY,
  applyColorModeToDocument,
  resolveInitialColorMode,
} from './colorMode';

/**
 * Compatibility theme for the MUI screens that have not yet moved to Astryx.
 * Values mirror the Astryx neutral tokens; Astryx remains the app theme owner.
 */
export const buildAppTheme = (mode: PaletteMode) => {
  const isDark = mode === 'dark';
  const background = isDark ? '#1b1b1b' : '#f1f1f1';
  const surface = isDark ? '#262626' : '#ffffff';
  const textPrimary = isDark ? '#fafafa' : '#171717';
  const textSecondary = isDark ? '#a3a3a3' : '#737373';
  const divider = isDark ? 'rgba(255, 255, 255, 0.10)' : '#ebebeb';
  const accent = isDark ? '#ebebeb' : '#262626';

  return createTheme({
    palette: {
      mode,
      primary: { main: accent },
      background: { default: background, paper: surface },
      text: { primary: textPrimary, secondary: textSecondary },
      divider,
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      button: { textTransform: 'none', fontWeight: 500 },
    },
    components: {
      MuiDrawer: {
        styleOverrides: { paper: { backgroundColor: background } },
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
