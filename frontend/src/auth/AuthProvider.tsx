import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getAuthUser, setAuthUser } from './authStore';
import type { AuthUser } from './authStore';
import { API_URL, AUTH_MODE, apiFetch } from '../services/apiClient';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  googleReady: boolean;
  googleError: string | null;
  authMode: 'oidc' | 'headers';
  signInWithEmail: (email: string, name?: string, userIdOverride?: string) => Promise<AuthUser>;
  signInWithGoogle: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

type AuthMeResponse = {
  authenticated: boolean;
  authMode?: string;
  user?: {
    userId: string;
    externalId: string;
    displayName: string;
    email?: string | null;
    isAdmin: boolean;
  } | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const normalizeAuthMode = (mode?: string): 'oidc' | 'headers' => {
  if ((mode || '').toLowerCase() === 'headers') {
    return 'headers';
  }
  return 'oidc';
};

const toAuthUser = (payload: AuthMeResponse['user']): AuthUser | null => {
  if (!payload?.userId || !payload.displayName) {
    return null;
  }
  const provider: AuthUser['provider'] = payload.externalId.startsWith('google-') ? 'google' : 'local';
  return {
    id: payload.userId,
    name: payload.displayName,
    email: payload.email || null,
    provider,
  };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authMode, setAuthMode] = useState<'oidc' | 'headers'>(() => normalizeAuthMode(AUTH_MODE));
  const [user, setUser] = useState<AuthUser | null>(() => (authMode === 'headers' ? getAuthUser() : null));
  const [loading, setLoading] = useState(authMode === 'oidc');
  const [googleError, setGoogleError] = useState<string | null>(null);

  const persistUser = useCallback((next: AuthUser | null) => {
    setAuthUser(next);
    setUser(next);
  }, []);

  const refreshSession = useCallback(async () => {
    if (authMode === 'headers') {
      persistUser(getAuthUser());
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

  const signInWithEmail = useCallback(async (email: string, name?: string, userIdOverride?: string) => {
    if (authMode !== 'headers') {
      throw new Error('Email/header sign-in is disabled in OIDC mode. Use Google sign-in.');
    }
    setLoading(true);
    try {
      if (!email.trim()) {
        throw new Error('Email is required');
      }
      const normalizedEmail = email.trim().toLowerCase();
      const displayName = (name || normalizedEmail).trim();
      const authedUser: AuthUser = {
        id: userIdOverride?.trim() || `local-${normalizedEmail}`,
        name: displayName,
        email: normalizedEmail,
        provider: 'local',
      };
      persistUser(authedUser);
      return authedUser;
    } finally {
      setLoading(false);
    }
  }, [authMode, persistUser]);

  const signInWithGoogle = useCallback(async (returnTo?: string) => {
    setGoogleError(null);
    const url = new URL(`${API_URL}/auth/google/start`, window.location.origin);
    if (returnTo) {
      url.searchParams.set('returnTo', returnTo);
    }
    window.location.assign(url.toString());
  }, []);

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
    googleReady: authMode === 'oidc',
    googleError,
    authMode,
    signInWithEmail,
    signInWithGoogle,
    signOut,
    refreshSession,
  }), [authMode, googleError, loading, refreshSession, signInWithEmail, signInWithGoogle, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
