import 'express-session';
import { UserContext } from './user';

declare module 'express-session' {
  interface GoogleOAuthSessionState {
    state: string;
    codeVerifier: string;
    returnTo?: string;
    extraScopes?: string[];
    expectedUserId?: string;
    createdAt: number;
  }

  interface SessionData {
    userContext?: UserContext;
    externalId?: string;
    isAdmin?: boolean;
    googleOAuth?: GoogleOAuthSessionState;
  }
}
