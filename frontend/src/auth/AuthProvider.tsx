import { createContext, useCallback, useContext, useMemo, useState } from 'react';
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
  signInWithGoogle: () => Promise<AuthUser>;
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

type PromptMomentNotification = {
  isNotDisplayed: () => boolean;
  isSkippedMoment: () => boolean;
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
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Google auth script'));
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

  const persistUser = useCallback((next: AuthUser | null) => {
    setAuthUser(next);
    setUser(next);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!GOOGLE_CLIENT_ID) {
      throw new Error('Google Client ID is not configured. Set VITE_GOOGLE_CLIENT_ID.');
    }
    setLoading(true);
    try {
      await loadGoogleScript();
      if (!window.google?.accounts?.id) {
        throw new Error('Google auth is unavailable right now');
      }
      const authedUser = await new Promise<AuthUser>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Google sign-in timed out. Please try again.'));
          }
        }, 20000);

        window.google!.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response: GoogleCredentialResponse) => {
            if (settled) return;
            if (!response?.credential) {
              settled = true;
              window.clearTimeout(timer);
              reject(new Error('No credential returned from Google.'));
              return;
            }
            const payload = decodeGoogleCredential(response.credential);
            if (!payload?.sub) {
              settled = true;
              window.clearTimeout(timer);
              reject(new Error('Unable to parse Google credential.'));
              return;
            }
            const userFromGoogle: AuthUser = {
              id: `google-${payload.sub}`,
              name: payload.name || payload.email || 'Google User',
              email: payload.email,
              avatarUrl: payload.picture || null,
              provider: 'google',
            };
            settled = true;
            window.clearTimeout(timer);
            resolve(userFromGoogle);
          },
        });

        window.google!.accounts.id.prompt((notification: PromptMomentNotification) => {
          if (settled) return;
          if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
            settled = true;
            window.clearTimeout(timer);
            reject(new Error('Google sign-in was cancelled.'));
          }
        });
      });
      persistUser(authedUser);
      return authedUser;
    } finally {
      setLoading(false);
    }
  }, [persistUser]);

  const signInWithEmail = useCallback(async (email: string, name?: string, userIdOverride?: string) => {
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
  }, [persistUser]);

  const signOut = useCallback(() => {
    persistUser(null);
  }, [persistUser]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    signInWithGoogle,
    signInWithEmail,
    signOut,
  }), [loading, signInWithEmail, signInWithGoogle, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
