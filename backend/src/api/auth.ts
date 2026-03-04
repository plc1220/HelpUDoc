import { Router } from 'express';
import { UserService } from '../services/userService';
import { GoogleOAuthService, GoogleOAuthConfigError } from '../services/googleOAuthService';

const AUTH_MODE = (process.env.AUTH_MODE || 'oidc').trim().toLowerCase();

type StartState = {
  state: string;
  codeVerifier: string;
  returnTo?: string;
  createdAt: number;
};

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

export default function authRoutes(userService: UserService, googleOAuthService: GoogleOAuthService) {
  const router = Router();

  router.get('/google/start', async (req, res) => {
    try {
      const codeVerifier = googleOAuthService.createPkceVerifier();
      const codeChallenge = googleOAuthService.createPkceChallenge(codeVerifier);
      const state = googleOAuthService.createStateToken();
      const returnTo = sanitizeReturnPath(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);

      const statePayload: StartState = {
        state,
        codeVerifier,
        returnTo,
        createdAt: Date.now(),
      };

      if (!req.session) {
        return res.status(500).json({ error: 'Session middleware is not configured' });
      }

      req.session.googleOAuth = statePayload;
      const redirectUrl = googleOAuthService.getAuthStartUrl({ state, codeChallenge });
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

      const oauthState = req.session?.googleOAuth;
      if (!oauthState || oauthState.state !== state) {
        return redirectWithError('state_mismatch');
      }

      const tokenResponse = await googleOAuthService.exchangeCodeForTokens(code, oauthState.codeVerifier);
      if (tokenResponse.idToken) {
        await googleOAuthService.verifyIdToken(tokenResponse.idToken);
      }
      const profile = await googleOAuthService.fetchProfile(tokenResponse.accessToken);

      const user = await userService.ensureUser({
        externalId: `google-${profile.sub}`,
        displayName: profile.name || profile.email || `google-${profile.sub}`,
        email: profile.email,
      });

      await googleOAuthService.upsertUserGoogleToken(user.id, tokenResponse);

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
      authMode: AUTH_MODE,
      user,
    });
  });

  router.post('/logout', async (req, res) => {
    if (AUTH_MODE === 'headers') {
      return res.status(200).json({ success: true });
    }

    if (!req.session) {
      return res.status(200).json({ success: true });
    }

    req.session.destroy((error) => {
      if (error) {
        console.error('Failed to destroy session', error);
        return res.status(500).json({ error: 'Failed to logout' });
      }
      return res.status(200).json({ success: true });
    });
  });

  return router;
}
