import 'express-session';
import { UserContext } from '../user';
import type { OidcTransaction } from '../../services/oidcService';

declare module 'express-session' {
  interface GoogleOAuthSessionState {
    state: string;
    codeVerifier: string;
    returnTo?: string;
    extraScopes?: string[];
  calendarOnly?: boolean;
  identityOnly?: boolean;
    expectedUserId?: string;
    createdAt: number;
  }

  interface SessionData {
    userContext?: UserContext;
    externalId?: string;
    isAdmin?: boolean;
    googleOAuth?: GoogleOAuthSessionState;
    oidcTransaction?: OidcTransaction;
    oidcLogin?: { idToken: string };
  }
}
