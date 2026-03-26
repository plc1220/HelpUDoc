import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './auth/AuthProvider';
import { applyColorModeToDocument, resolveInitialColorMode } from './colorMode';

// Apply the persisted color mode before React renders so direct-route loads
// (for example /settings) honor the user's theme immediately.
applyColorModeToDocument(resolveInitialColorMode());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
