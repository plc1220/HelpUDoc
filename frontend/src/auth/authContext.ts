import { createContext } from 'react';
import type { AuthUser } from './authStore';

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  googleReady: boolean;
  googleError: string | null;
  authMode: 'oidc' | 'headers' | 'hybrid';
  signInWithGoogle: (returnTo?: string) => Promise<void>;
  signInWithHeaders: (profile: { name: string; email?: string | null }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
