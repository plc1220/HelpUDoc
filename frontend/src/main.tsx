import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './auth/AuthProvider';
import {
  APP_COLOR_MODE_CHANGE_EVENT,
  APP_COLOR_MODE_STORAGE_KEY,
  applyColorModeToDocument,
  resolveInitialColorMode,
} from './colorMode';

// Apply the persisted color mode before React renders so direct-route loads do not flash.
applyColorModeToDocument(resolveInitialColorMode());

const AppThemeRoot = ({ children }: { children: ReactNode }) => {
  const [mode, setMode] = useState(resolveInitialColorMode);

  useEffect(() => {
    const handleModeChange = (event: Event) => {
      const next = (event as CustomEvent<'light' | 'dark'>).detail;
      if (next === 'light' || next === 'dark') {
        setMode(next);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === APP_COLOR_MODE_STORAGE_KEY && (event.newValue === 'light' || event.newValue === 'dark')) {
        setMode(event.newValue);
      }
    };
    window.addEventListener(APP_COLOR_MODE_CHANGE_EVENT, handleModeChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(APP_COLOR_MODE_CHANGE_EVENT, handleModeChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return (
    <Theme theme={neutralTheme} mode={mode}>
      {children}
    </Theme>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppThemeRoot>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </AppThemeRoot>
  </StrictMode>,
);
