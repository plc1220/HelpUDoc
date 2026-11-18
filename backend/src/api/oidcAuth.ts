import { Router, type Request } from 'express';
import { OidcService, oidcExternalId, loginProvider } from '../services/oidcService';
import { isUserDeactivated, type UserService } from '../services/userService';

const TRANSACTION_TTL = 10 * 60 * 1000;
const sessionAction = (req: Request, action: 'save' | 'regenerate') => new Promise<void>((resolve, reject) => {
  if (!req.session) return reject(new Error('Session middleware is not configured'));
  req.session[action]((error) => error ? reject(error) : resolve());
});

export default function oidcAuthRoutes(users: UserService, service: OidcService, signupMode: () => string) {
  const router = Router();
  router.get('/start', async (req, res) => {
    if (loginProvider() !== 'oidc' || process.env.AUTH_MODE === 'headers') return res.sendStatus(404);
    if (!service.isConfigured()) return res.status(503).json({ error: 'Single sign-on is not configured' });
    try {
      const result = await service.begin(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
      await sessionAction(req, 'regenerate');
      req.session.oidcTransaction = result.transaction;
      await sessionAction(req, 'save');
      return res.redirect(302, result.url);
    } catch {
      // Provider responses can contain codes or tokens; never log raw exceptions.
      console.error('Failed to start OIDC sign-in');
      return res.status(503).json({ error: 'Unable to contact single sign-on' });
    }
  });

  router.get('/callback', async (req, res) => {
    if (loginProvider() !== 'oidc' || process.env.AUTH_MODE === 'headers') return res.sendStatus(404);
    const reject = (reason: string) => res.redirect(302, service.loginRedirect(reason));
    const transaction = req.session?.oidcTransaction;
    if (!transaction) return reject('oidc_session_expired');
    try {
      // Consume server-side state before token exchange. No cookie-only fallback.
      delete req.session.oidcTransaction;
      await sessionAction(req, 'save');
      if (typeof req.query.state !== 'string' || req.query.state !== transaction.state
        || Date.now() - transaction.createdAt > TRANSACTION_TTL || transaction.createdAt > Date.now()) {
        return reject('oidc_state_mismatch');
      }
      const query = req.originalUrl.slice(req.originalUrl.indexOf('?'));
      const identity = await service.complete(query, transaction);
      // Unverified email cannot claim invitations or match ADMIN_EMAILS.
      const email = identity.emailVerified ? identity.email : undefined;
      const profile = {
        externalId: oidcExternalId(identity.issuer, identity.subject),
        oidcIssuer: identity.issuer, oidcSubject: identity.subject,
        displayName: identity.displayName, email, emailVerified: identity.emailVerified,
      };
      if (signupMode() === 'invite_only' && !await users.isAdmissibleSignIn(profile)) return reject('not_invited');
      const user = await users.ensureUser(profile);
      if (isUserDeactivated(user)) return reject('account_deactivated');
      await sessionAction(req, 'regenerate');
      req.session.userContext = {
        userId: user.id, externalId: user.externalId, displayName: user.displayName,
        email: user.email, isAdmin: user.isAdmin,
      };
      req.session.externalId = user.externalId;
      req.session.oidcLogin = { idToken: identity.idToken };
      await sessionAction(req, 'save');
      return res.redirect(302, service.loginRedirect(undefined, transaction.returnTo));
    } catch {
      console.error('OIDC sign-in callback failed');
      return reject('oidc_callback_failed');
    }
  });
  return router;
}
