import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { AppThemeRoot } from '../../src/AppThemeRoot';
import ExpandableSidebar from '../../src/components/ExpandableSidebar';
import '../../src/index.css';
import { AuthContext, type AuthContextValue } from '../../src/auth/authContext';
import { NotificationProvider } from '../../src/components/NotificationCenter';
const auth = { user: { id: 'alice', name: 'Alice' }, loading: false } as AuthContextValue;
export function Fixture() {
  const location = useLocation();
  return <AuthContext.Provider value={auth}><AppThemeRoot><NotificationProvider>
    <div style={{ display: 'flex', minHeight: '100vh' }}><ExpandableSidebar handleDrawerToggle={() => {}} isDrawerOpen={false} onOpenSettings={() => {}} /><p style={{ padding: 24 }} aria-label="Destination">{location.search}</p></div>
  </NotificationProvider></AppThemeRoot></AuthContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
