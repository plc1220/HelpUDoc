import { Request, Router } from 'express';
import { createHash } from 'crypto';
import { UserService, isUserDeactivated } from '../services/userService';
import { GoogleOAuthService, GoogleOAuthConfigError, GOOGLE_OIDC_ISSUER } from '../services/googleOAuthService';
import { OidcService, loginProvider } from '../services/oidcService';
import oidcAuthRoutes from './oidcAuth';

type AuthMode = 'headers' | 'oidc' | 'hybrid';

function resolveAuthMode(raw?: string): AuthMode {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'headers' || normalized === 'oidc' || normalized === 'hybrid') {
    return normalized;
  }
  return 'hybrid';
}

const authMode = () => resolveAuthMode(process.env.AUTH_MODE);

type StartState = {
  state: string;
  codeVerifier: string;
  returnTo?: string;
  extraScopes?: string[];
  calendarOnly?: boolean;
  identityOnly?: boolean;
  expectedUserId?: string;
  createdAt: number;
};

const OAUTH_STATE_COOKIE = 'helpudoc.oauth.state';
const OAUTH_VERIFIER_COOKIE = 'helpudoc.oauth.verifier';
const OAUTH_RETURN_TO_COOKIE = 'helpudoc.oauth.return_to';
const OAUTH_PURPOSE_COOKIE = 'helpudoc.oauth.purpose';
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const sessionCookieName = () => process.env.SESSION_NAME || 'helpudoc.sid';

function cookieSecure(): boolean {
  const raw = (process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'production';
}

function parseCookieHeader(header?: string): Record<string, string> {
  if (!header) {
    return {};
  }
  return header.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValueParts] = part.split('=');
    const key = rawKey?.trim();
    if (!key) {
      return acc;
    }
    const rawValue = rawValueParts.join('=').trim();
    try {
      acc[key] = decodeURIComponent(rawValue);
    } catch {
      acc[key] = rawValue;
    }
    return acc;
  }, {});
}

function sanitizeReturnPath(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (!raw.startsWith('/')) {
    return undefined;
  }
  if (raw.startsWith('//')) {
    return undefined;
  }
  return raw;
}

/**
 * `open` (default) keeps today's behaviour: anyone who can authenticate gets an
 * account. `invite_only` admits only identities that already have an account or
 * a pre-registration. Read per request rather than at module load, matching how
 * `AUTH_MODE` is handled — module-level reads observe the pre-dotenv env.
 */
export type SignupMode = 'open' | 'invite_only';
export const signupMode = (): SignupMode => (
  (process.env.SIGNUP_MODE || '').trim().toLowerCase() === 'invite_only' ? 'invite_only' : 'open'
);

export default function authRoutes(userService: UserService, googleOAuthService: GoogleOAuthService, oidcService = new OidcService()) {
  const router = Router();
  router.use('/oidc', oidcAuthRoutes(userService, oidcService, signupMode));
  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookieSecure(),
    domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
  };

  const saveSession = (req: Request) =>
    new Promise<void>((resolve, reject) => {
      if (!req.session) {
        reject(new Error('Session middleware is not configured'));
        return;
      }
      req.session.save((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  router.get('/google/start', async (req, res) => {
    if (authMode() === 'headers') {
      return res.status(400).json({ error: 'Google sign-in is disabled when AUTH_MODE=headers' });
    }
    if (!googleOAuthService.isConfigured()) {
      return res.status(503).json({ error: 'Google OAuth is not configured on this server' });
    }

    try {
      const codeVerifier = googleOAuthService.createPkceVerifier();
      const codeChallenge = googleOAuthService.createPkceChallenge(codeVerifier);
      const state = googleOAuthService.createStateToken();
      const returnTo = sanitizeReturnPath(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
      const requestedExtras = typeof req.query.extraScopes === 'string'
        ? req.query.extraScopes.split(/[\s,]+/).filter(Boolean)
        : [];
      const calendarOnly = req.query.calendar === 'true';
      const identityOnly = req.query.identityOnly === 'true';
      if (loginProvider() === 'oidc' && !calendarOnly && !requestedExtras.length) {
        return res.status(400).json({ error: 'Use the configured single sign-on provider' });
      }
      if (identityOnly && (calendarOnly || requestedExtras.length)) return res.status(400).json({ error: 'Identity sign-in cannot request service permissions' });
      const extraScopes = [...new Set(calendarOnly && !requestedExtras.length ? ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'] : requestedExtras)];
      if (!calendarOnly && extraScopes.some(scope => scope.includes('/auth/calendar.'))) return res.status(400).json({ error: 'Calendar permissions require a dedicated Calendar connection' });
      if (calendarOnly && !req.userContext?.userId) return res.status(401).json({ error: 'Sign in before connecting Calendar' });
      if (extraScopes.some((scope) => !['drive.file', 'calendar.calendarlist.readonly', 'calendar.events', 'calendar.events.readonly'].some(suffix => scope === `https://www.googleapis.com/auth/${suffix}`))) {
        return res.status(400).json({ error: 'Unsupported additional Google OAuth scope' });
      }
      if (extraScopes.length && !req.userContext?.userId) {
        return res.status(401).json({ error: 'Sign in before connecting Google services' });
      }

      const statePayload: StartState = {
        state,
        codeVerifier,
        returnTo,
        extraScopes,
        calendarOnly,
        identityOnly,
        expectedUserId: calendarOnly || extraScopes.length ? req.userContext?.userId : undefined,
        createdAt: Date.now(),
      };

      if (!req.session) {
        return res.status(500).json({ error: 'Session middleware is not configured' });
      }

      req.session.googleOAuth = statePayload;
      await saveSession(req);
      const secure = cookieSecure();
      res.cookie(OAUTH_PURPOSE_COOKIE, calendarOnly ? 'calendar' : identityOnly ? 'identity' : 'login', { httpOnly: true, sameSite: 'lax', secure, maxAge: OAUTH_COOKIE_MAX_AGE_MS });
      res.cookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      });
      res.cookie(OAUTH_VERIFIER_COOKIE, codeVerifier, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      });
      if (returnTo) {
        res.cookie(OAUTH_RETURN_TO_COOKIE, returnTo, {
          httpOnly: true,
          sameSite: 'lax',
          secure,
          maxAge: OAUTH_COOKIE_MAX_AGE_MS,
        });
      } else {
        res.clearCookie(OAUTH_RETURN_TO_COOKIE, {
          httpOnly: true,
          sameSite: 'lax',
          secure,
        });
      }
      const redirectUrl = googleOAuthService.getAuthStartUrl({ state, codeChallenge, extraScopes, calendarOnly, identityOnly });
      return res.redirect(302, redirectUrl);
    } catch (error) {
      if (error instanceof GoogleOAuthConfigError) {
        return res.status(500).json({ error: error.message });
      }
      console.error('Failed to start Google OAuth flow', error);
      return res.status(500).json({ error: 'Failed to start Google OAuth flow' });
    }
  });

  router.get('/google/callback', async (req, res) => {
    const redirectWithError = (reason: string) => {
      const target = googleOAuthService.getPostLoginRedirectUrl(reason);
      return res.redirect(302, target);
    };

    try {
      const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
      if (oauthError) {
        return redirectWithError(oauthError);
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (!code || !state) {
        return redirectWithError('missing_code_or_state');
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const sessionState = req.session?.googleOAuth;
      if (cookies[OAUTH_PURPOSE_COOKIE] === 'calendar' && !sessionState?.calendarOnly) return redirectWithError('calendar_session_expired');
      if (cookies[OAUTH_PURPOSE_COOKIE] === 'identity' && !sessionState?.identityOnly) return redirectWithError('identity_session_expired');
      const oauthState = sessionState || (
        cookies[OAUTH_STATE_COOKIE] && cookies[OAUTH_VERIFIER_COOKIE]
          ? {
              state: cookies[OAUTH_STATE_COOKIE],
              codeVerifier: cookies[OAUTH_VERIFIER_COOKIE],
              returnTo: cookies[OAUTH_RETURN_TO_COOKIE],
              createdAt: Date.now(),
            }
          : undefined
      );
      if (!oauthState || oauthState.state !== state || Date.now() - oauthState.createdAt > OAUTH_COOKIE_MAX_AGE_MS) {
        return redirectWithError('state_mismatch');
      }

      const tokenResponse = await googleOAuthService.exchangeCodeForTokens(code, oauthState.codeVerifier);
      if (tokenResponse.idToken) {
        await googleOAuthService.verifyIdToken(tokenResponse.idToken);
      }
      const profile = await googleOAuthService.fetchProfile(tokenResponse.accessToken);

      if (sessionState?.calendarOnly) {
        // A Calendar grant belongs to the already-authenticated Lumo user. It never
        // replaces their login identity or the general-purpose agent Google grant.
        if (!sessionState.expectedUserId || sessionState.expectedUserId !== req.userContext?.userId || Date.now() - sessionState.createdAt > OAUTH_COOKIE_MAX_AGE_MS) return redirectWithError('calendar_session_expired');
        const provider = `calendar:${createHash('sha256').update(profile.sub).digest('hex').slice(0, 32)}` as const;
        await googleOAuthService.upsertUserGoogleToken(sessionState.expectedUserId, { ...tokenResponse, principal: profile.email || 'Google account' }, provider);
        req.session!.googleOAuth = undefined;
        await saveSession(req);
        const secure = cookieSecure();
        for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_RETURN_TO_COOKIE, OAUTH_PURPOSE_COOKIE]) res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure });
        const target = new URL(googleOAuthService.getPostLoginRedirectUrl());
        const returnPath = new URL(sanitizeReturnPath(sessionState.returnTo) || '/?calendar=open', target.origin);
        target.pathname = returnPath.pathname; target.search = returnPath.search;
        return res.redirect(302, target.toString());
      }

      if (loginProvider() === 'oidc') {
        // Google service consent belongs to the already authenticated Keycloak
        // user; it must never replace the application login identity.
        if (!sessionState?.expectedUserId || sessionState.expectedUserId !== req.userContext?.userId
          || !sessionState.extraScopes?.length || Date.now() - sessionState.createdAt > OAUTH_COOKIE_MAX_AGE_MS) {
          return redirectWithError('google_login_disabled');
        }
        await googleOAuthService.upsertUserGoogleToken(sessionState.expectedUserId, tokenResponse);
        req.session!.googleOAuth = undefined;
        await saveSession(req);
        for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_RETURN_TO_COOKIE, OAUTH_PURPOSE_COOKIE]) {
          res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: cookieSecure() });
        }
        const target = new URL(googleOAuthService.getPostLoginRedirectUrl());
        const returnTo = sanitizeReturnPath(sessionState.returnTo);
        if (returnTo) target.searchParams.set('returnTo', returnTo);
        return res.redirect(302, target.toString());
      }

      // Under invite-only, a Google identity that matches neither an existing
      // account nor a pre-registered address is refused before any row is
      // created. Existing accounts are never gated, so turning the flag on
      // cannot lock out the people already using the system.
      if (signupMode() === 'invite_only') {
        const admissible = await userService.isAdmissibleSignIn({
          externalId: `google-${profile.sub}`,
          email: profile.email,
          oidcIssuer: GOOGLE_OIDC_ISSUER,
          oidcSubject: profile.sub,
        });
        if (!admissible) {
          return redirectWithError('not_invited');
        }
      }

      const user = await userService.ensureUser({
        externalId: `google-${profile.sub}`,
        displayName: profile.name || profile.email || `google-${profile.sub}`,
        email: profile.email,
        emailVerified: profile.emailVerified,
        oidcIssuer: GOOGLE_OIDC_ISSUER,
        oidcSubject: profile.sub,
      });

      // Refuse before a session exists. Minting one and relying on the request
      // middleware to reject it afterwards would leave the user in a sign-in
      // loop with no explanation of why.
      if (isUserDeactivated(user)) {
        return redirectWithError('account_deactivated');
      }
      if (oauthState.expectedUserId && oauthState.expectedUserId !== user.id) {
        return redirectWithError('google_account_mismatch');
      }

      // A basic sign-in must not replace an existing Google service grant.
      if (!sessionState?.identityOnly) await googleOAuthService.upsertUserGoogleToken(user.id, tokenResponse);

      if (req.session) {
        req.session.userContext = {
          userId: user.id,
          externalId: user.externalId,
          displayName: user.displayName,
          email: user.email,
          isAdmin: user.isAdmin,
        };
        req.session.externalId = user.externalId;
        req.session.googleOAuth = undefined;
      }
      const secure = cookieSecure();
      res.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, sameSite: 'lax', secure });
      res.clearCookie(OAUTH_VERIFIER_COOKIE, { httpOnly: true, sameSite: 'lax', secure });
      res.clearCookie(OAUTH_RETURN_TO_COOKIE, { httpOnly: true, sameSite: 'lax', secure });
      res.clearCookie(OAUTH_PURPOSE_COOKIE, { httpOnly: true, sameSite: 'lax', secure });

      const base = googleOAuthService.getPostLoginRedirectUrl();
      const url = new URL(base);
      const returnTo = sanitizeReturnPath(oauthState.returnTo);
      if (returnTo) {
        url.searchParams.set('returnTo', returnTo);
      }
      return res.redirect(302, url.toString());
    } catch (error) {
      console.error('Google OAuth callback failed', error);
      return redirectWithError('oauth_callback_failed');
    }
  });

  router.get('/me', async (req, res) => {
    const user = req.userContext || null;
    return res.json({
      authenticated: Boolean(user),
      authMode: authMode(),
      authProvider: loginProvider(),
      loginConfigured: loginProvider() === 'oidc' ? oidcService.isConfigured() : googleOAuthService.isConfigured(),
      loginLabel: loginProvider() === 'oidc' ? oidcService.displayName : 'Google',
      googleConfigured: googleOAuthService.isConfigured(),
      user,
    });
  });

  router.post('/logout', async (req, res) => {
    if (authMode() === 'headers') {
      res.clearCookie(sessionCookieName(), sessionCookieOptions);
      return res.status(200).json({ success: true });
    }

    if (!req.session) {
      res.clearCookie(sessionCookieName(), sessionCookieOptions);
      return res.status(200).json({ success: true });
    }

    let redirectUrl: string | undefined;
    if (req.session.oidcLogin) {
      // An unrelated origin must not be able to terminate the shared SSO session.
      if (req.headers.origin) {
        try {
          if (new URL(oidcService.loginRedirect()).origin !== req.headers.origin) return res.sendStatus(403);
        } catch { return res.sendStatus(503); }
      }
      try { redirectUrl = await oidcService.logoutUrl(req.session.oidcLogin.idToken); }
      catch { console.error('OIDC provider logout unavailable; clearing local session'); }
    }
    req.session.destroy((error) => {
      if (error) {
        console.error('Failed to destroy session', error);
        return res.status(500).json({ error: 'Failed to logout' });
      }
      res.clearCookie(sessionCookieName(), sessionCookieOptions);
      return res.status(200).json({ success: true, ...(redirectUrl ? { redirectUrl } : {}) });
    });
  });

  return router;
}
