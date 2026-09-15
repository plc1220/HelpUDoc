import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material';
import { AuthContext, type AuthContextValue } from '../../src/auth/authContext';
import NotificationCenter, { NotificationProvider } from '../../src/components/NotificationCenter';
const auth = { user: { id: 'alice', name: 'Alice' }, loading: false } as AuthContextValue;
function Fixture() {
  const location = useLocation();
  return <AuthContext.Provider value={auth}><ThemeProvider theme={createTheme()}><NotificationProvider>
    <NotificationCenter /><p aria-label="Destination">{location.search}</p>
  </NotificationProvider></ThemeProvider></AuthContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
