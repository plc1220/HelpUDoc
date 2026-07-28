import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import { AppThemeRoot } from './AppThemeRoot';
import { AuthProvider } from './auth/AuthProvider';
import { applyColorModeToDocument, resolveInitialColorMode } from './colorMode';

// Apply the persisted color mode before React renders so direct-route loads do not flash.
applyColorModeToDocument(resolveInitialColorMode());

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
