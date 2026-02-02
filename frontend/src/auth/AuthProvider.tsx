import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAuthUser, setAuthUser } from './authStore';
import type { AuthUser } from './authStore';

declare global {
  interface Window {
    google?: any;
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  googleReady: boolean;
  googleError: string | null;
  signInWithEmail: (email: string, name?: string, userIdOverride?: string) => Promise<AuthUser>;
  signOut: () => void;
}

type GoogleCredentialPayload = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

type GoogleCredentialResponse = {
  credential?: string;
};

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const loadGoogleScript = (() => {
  let promise: Promise<void> | null = null;
  return () => {
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined') {
        return reject(new Error('Google auth is only available in the browser'));
      }
      if (window.google?.accounts?.id) {
        return resolve();
      }
      const script = document.createElement('script');
      const timeout = window.setTimeout(() => {
        reject(new Error('Google auth script load timed out. Check blockers or network.'));
      }, 8000);

      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Failed to load Google auth script'));
      };
      document.head.appendChild(script);
    });
    return promise;
  };
})();

function decodeGoogleCredential(token: string): GoogleCredentialPayload | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized);
    return JSON.parse(decoded);
  } catch (error) {
    console.warn('Failed to parse Google credential', error);
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => getAuthUser());
  const [loading, setLoading] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const googleInitRef = useRef(false);

  const persistUser = useCallback((next: AuthUser | null) => {
    setAuthUser(next);
    setUser(next);
  }, []);

  const handleGoogleCredential = useCallback((response: GoogleCredentialResponse) => {
    if (!response?.credential) {
      console.warn('No credential returned from Google.');
      return;
    }
    const payload = decodeGoogleCredential(response.credential);
    if (!payload?.sub) {
      console.warn('Unable to parse Google credential.');
      return;
    }
    const userFromGoogle: AuthUser = {
      id: `google-${payload.sub}`,
      name: payload.name || payload.email || 'Google User',
      email: payload.email,
      avatarUrl: payload.picture || null,
      provider: 'google',
    };
    persistUser(userFromGoogle);
  }, [persistUser]);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setGoogleError('Google Client ID is not configured. Set VITE_GOOGLE_CLIENT_ID.');
      setGoogleReady(false);
      return;
    }
    let cancelled = false;
    setGoogleError(null);

    const initGoogle = async () => {
      try {
        await loadGoogleScript();
        if (cancelled) return;
        if (!window.google?.accounts?.id) {
          throw new Error('Google auth is unavailable right now');
        }
        if (!googleInitRef.current) {
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGoogleCredential,
            ux_mode: 'popup',
          });
          googleInitRef.current = true;
        }
        if (!cancelled) {
          setGoogleReady(true);
        }
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to initialize Google auth', error);
        setGoogleError(error instanceof Error ? error.message : 'Failed to initialize Google auth.');
        setGoogleReady(false);
      }
    };

    initGoogle();

    return () => {
      cancelled = true;
    };
  }, [handleGoogleCredential]);

  const signInWithEmail = useCallback(async (email: string, name?: string, userIdOverride?: string) => {
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
  }, [persistUser]);

  const signOut = useCallback(() => {
    persistUser(null);
  }, [persistUser]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    googleReady,
    googleError,
    signInWithEmail,
    signOut,
  }), [googleError, googleReady, loading, signInWithEmail, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
