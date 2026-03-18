import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getAuthUser, setAuthUser } from './authStore';
import type { AuthUser } from './authStore';
import { API_URL, AUTH_MODE, apiFetch } from '../services/apiClient';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  googleReady: boolean;
  googleError: string | null;
  authMode: 'oidc' | 'headers' | 'hybrid';
  signInWithGoogle: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

type AuthMeResponse = {
  authenticated: boolean;
  authMode?: string;
  googleConfigured?: boolean;
  user?: {
    userId: string;
    externalId: string;
    displayName: string;
    email?: string | null;
    isAdmin: boolean;
  } | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

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
  const provider: AuthUser['provider'] = payload.externalId.startsWith('google-') ? 'google' : 'local';
  return {
    // Header-based auth expects the stable external identity, not the DB primary key.
    id: payload.externalId,
    name: payload.displayName,
    email: payload.email || null,
    provider,
  };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authMode, setAuthMode] = useState<'oidc' | 'headers' | 'hybrid'>(() => normalizeAuthMode(AUTH_MODE));
  const [user, setUser] = useState<AuthUser | null>(() => (authMode === 'oidc' ? null : getAuthUser()));
  const [loading, setLoading] = useState(authMode !== 'headers');
  const [googleConfigured, setGoogleConfigured] = useState<boolean>(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const persistUser = useCallback((next: AuthUser | null) => {
    setAuthUser(next);
    setUser(next);
  }, []);

  const refreshSession = useCallback(async () => {
    if (authMode === 'headers') {
      persistUser(getAuthUser());
      setGoogleConfigured(false);
      setGoogleError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await apiFetch(`${API_URL}/auth/me`);
      if (!response.ok) {
        persistUser(null);
        return;
      }
      const payload = (await response.json()) as AuthMeResponse;
      const serverMode = normalizeAuthMode(payload.authMode);
      setAuthMode(serverMode);
      const googleIsConfigured = Boolean(payload.googleConfigured);
      setGoogleConfigured(googleIsConfigured);
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
  }, [authMode, googleConfigured]);

  const signOut = useCallback(async () => {
    if (authMode === 'headers') {
      persistUser(null);
      return;
    }

    try {
      await apiFetch(`${API_URL}/auth/logout`, {
        method: 'POST',
      });
    } catch (error) {
      console.error('Failed to sign out', error);
    } finally {
      persistUser(null);
    }
  }, [authMode, persistUser]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    googleReady: authMode !== 'headers',
    googleError,
    authMode,
    signInWithGoogle,
    signOut,
    refreshSession,
  }), [authMode, googleConfigured, googleError, loading, refreshSession, signInWithGoogle, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
