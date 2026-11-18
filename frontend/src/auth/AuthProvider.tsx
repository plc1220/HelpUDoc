import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAuthUser, setAuthUser } from './authStore';
import type { AuthUser } from './authStore';
import { API_URL, AUTH_MODE, apiFetch } from '../services/apiClient';
import { AuthContext, type AuthContextValue } from './authContext';

type AuthMeResponse = {
  authenticated: boolean;
  authMode?: string;
  googleConfigured?: boolean;
  authProvider?: 'google' | 'oidc' | 'pcai-proxy';
  loginConfigured?: boolean;
  loginLabel?: string;
  loginError?: string;
  user?: {
    userId: string;
    externalId: string;
    displayName: string;
    email?: string | null;
    isAdmin: boolean;
  } | null;
};

const normalizeAuthMode = (mode?: string): 'oidc' | 'headers' | 'hybrid' => {
  const normalized = (mode || '').toLowerCase();
  if (normalized === 'headers') {
    return 'headers';
  }
  if (normalized === 'oidc') {
    return 'oidc';
  }
  return 'hybrid';
};

const toAuthUser = (payload: AuthMeResponse['user']): AuthUser | null => {
  if (!payload?.externalId || !payload.displayName) {
    return null;
  }
  const provider: AuthUser['provider'] = payload.externalId.startsWith('google-') ? 'google'
    : payload.externalId.startsWith('oidc-') ? 'oidc' : 'local';
  return {
    // Header-based auth expects the stable external identity, not the DB primary key.
    id: payload.externalId,
    name: payload.displayName,
    email: payload.email || null,
    provider,
  };
};

const buildHeaderAuthUser = (profile: { name: string; email?: string | null }): AuthUser => {
  const normalizedName = profile.name.trim() || 'Local User';
  const normalizedEmail = profile.email?.trim() || null;
  const stableId = normalizedEmail || `local-${normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return {
    id: stableId,
    name: normalizedName,
    email: normalizedEmail,
    provider: 'local',
  };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authMode, setAuthMode] = useState<'oidc' | 'headers' | 'hybrid'>(() => normalizeAuthMode(AUTH_MODE));
  const [user, setUser] = useState<AuthUser | null>(() => (authMode === 'oidc' ? null : getAuthUser()));
  const [loading, setLoading] = useState(authMode !== 'headers');
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [authProvider, setAuthProvider] = useState<'google' | 'oidc' | 'pcai-proxy'>('google');
  const [loginLabel, setLoginLabel] = useState('Google');
  const [loginConfigured, setLoginConfigured] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const persistUser = useCallback((next: AuthUser | null) => {
    setAuthUser(next);
    setUser(next);
  }, []);

  const refreshSession = useCallback(async () => {
    if (authMode === 'headers') {
      persistUser(getAuthUser());
      setGoogleError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await apiFetch(`${API_URL}/auth/me`);
      if (!response.ok) {
        persistUser(null);
        setLoginConfigured(false);
        setLoginError('Unable to check sign-in availability. Please try again.');
        return;
      }
      const payload = (await response.json()) as AuthMeResponse;
      const serverMode = normalizeAuthMode(payload.authMode);
      setAuthMode(serverMode);
      const googleIsConfigured = Boolean(payload.googleConfigured);
      const provider = payload.authProvider === 'pcai-proxy' ? 'pcai-proxy' : payload.authProvider === 'oidc' ? 'oidc' : 'google';
      const configured = payload.loginConfigured ?? googleIsConfigured;
      setAuthProvider(provider);
      setLoginLabel(payload.loginLabel || (provider === 'google' ? 'Google' : 'Single sign-on'));
      setLoginConfigured(configured);
      setLoginError(payload.loginError || (serverMode !== 'headers' && !configured ? 'Sign-in is unavailable. Contact your administrator.' : null));
      setGoogleError(
        serverMode !== 'headers' && !googleIsConfigured
          ? 'Google sign-in is unavailable (server OAuth is not configured).'
          : null,
      );
      if (payload.authenticated && payload.user) {
        persistUser(toAuthUser(payload.user));
      } else {
        persistUser(null);
      }
    } catch (error) {
      console.error('Failed to refresh auth session', error);
      setLoginConfigured(false);
      setLoginError('Unable to check sign-in availability. Please try again.');
      persistUser(null);
    } finally {
      setLoading(false);
    }
  }, [authMode, persistUser]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const signInWithGoogle = useCallback(async (returnTo?: string) => {
    if (authMode === 'headers') {
      throw new Error('Google sign-in is disabled in header mode.');
    }
    setGoogleError(null);
    const url = new URL(`${API_URL}/auth/google/start`, window.location.origin);
    if (returnTo) {
      url.searchParams.set('returnTo', returnTo);
    }
    window.location.assign(url.toString());
  }, [authMode]);

  const signIn = useCallback(async (returnTo?: string) => {
    if (authMode === 'headers') throw new Error('Single sign-on is disabled in development mode.');
    setLoginError(null);
    if (authProvider === 'pcai-proxy') {
      // A top-level navigation lets PCAI renew its own SSO session. No browser
      // token storage or separate application OAuth client is needed.
      const target = new URL(returnTo || '/', window.location.origin);
      window.location.assign(target.origin === window.location.origin ? target.toString() : window.location.origin);
      return;
    }
    const url = new URL(`${API_URL}/auth/${authProvider === 'oidc' ? 'oidc' : 'google'}/start`, window.location.origin);
    if (returnTo) url.searchParams.set('returnTo', returnTo);
    window.location.assign(url.toString());
  }, [authMode, authProvider]);

  const signInWithHeaders = useCallback(async (profile: { name: string; email?: string | null }) => {
    persistUser(buildHeaderAuthUser(profile));
    setGoogleError(null);
  }, [persistUser]);

  const signOut = useCallback(async () => {
    persistUser(null);
    if (authMode === 'headers') {
      return;
    }

    try {
      const response = await apiFetch(`${API_URL}/auth/logout`, {
        method: 'POST',
      });
      if (!response.ok) {
        console.error('Failed to sign out', response.status, response.statusText);
      } else {
        const result = await response.json() as { redirectUrl?: string };
        if (result.redirectUrl) window.location.assign(result.redirectUrl);
      }
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  }, [authMode, persistUser]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    googleReady: authMode !== 'headers',
    googleError,
    authProvider,
    loginLabel,
    loginReady: !loading && authMode !== 'headers' && loginConfigured,
    loginError,
    signIn,
    authMode,
    signInWithGoogle,
    signInWithHeaders,
    signOut,
    refreshSession,
  }), [authMode, authProvider, loginLabel, loginConfigured, loginError, googleError, loading, refreshSession, signIn, signInWithGoogle, signInWithHeaders, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
