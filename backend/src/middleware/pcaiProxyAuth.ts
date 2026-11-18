import type { Request, Response, NextFunction } from 'express';
import { PcaiProxyService } from '../services/pcaiProxyService';
import { oidcExternalId } from '../services/oidcService';
import { isUserDeactivated, type UserService } from '../services/userService';

export function pcaiProxyAuth(users: UserService, verifier = new PcaiProxyService()) {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.userContext = undefined;
    res.locals.userContext = undefined;
    const clearIdentity = () => {
      if (!req.session) return;
      delete req.session.userContext;
      delete req.session.externalId;
      delete req.session.oidcLogin;
      delete req.session.googleOAuth;
    };
    const refuse = (status: number, code: string, error: string) => {
      clearIdentity();
      // The SPA can explain admission/token problems without attempting another login flow.
      if (req.path === '/api/auth/me') {
        res.locals.pcaiAuthError = { code, message: error };
        return next();
      }
      return res.status(status).json({ error, code });
    };
    // Internal callbacks have their own signed agent JWT and scope checks.
    // Never turn that token (or a stored browser session) into userContext.
    if (req.path.startsWith('/api/internal/agent/')) return next();
    // The platform cookie is shared across applications. Another site's page
    // must not use it to read or mutate Lumo through credentialed requests.
    if (req.headers.origin && req.headers.origin !== verifier.applicationOrigin) {
      return res.status(403).json({ error: 'Request origin is not allowed', code: 'origin_not_allowed' });
    }
    if (req.path === '/api/auth/logout') return next();
    const authorization = req.header('authorization');
    if (!authorization) return refuse(401, 'pcai_token_missing', 'Open Lumo Studio from PCAI to continue.');
    let identity: Awaited<ReturnType<PcaiProxyService['verify']>>;
    try { identity = await verifier.verify(authorization); }
    catch {
      // Do not log tokens, claims or provider exceptions.
      return refuse(401, 'pcai_token_invalid', 'Your PCAI sign-in could not be verified. Reopen Lumo Studio from PCAI.');
    }
    try {
      const profile = {
        externalId: oidcExternalId(identity.issuer, identity.subject),
        oidcIssuer: identity.issuer, oidcSubject: identity.subject,
        displayName: identity.displayName, email: identity.email, emailVerified: identity.emailVerified,
      };
      if ((process.env.SIGNUP_MODE || '').trim().toLowerCase() === 'invite_only' && !await users.isAdmissibleSignIn(profile)) {
        return refuse(403, 'not_invited', 'Your account has not been invited. Contact your administrator.');
      }
      const user = await users.ensureUser(profile);
      if (isUserDeactivated(user)) return refuse(403, 'account_deactivated', 'Your account is deactivated. Contact your administrator.');
      if (req.session && req.session.externalId !== user.externalId) {
        // Rotate on initial sign-in and account switches, discarding earlier OAuth transactions.
        await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      }
      const context = {
        userId: user.id, externalId: user.externalId, displayName: user.displayName,
        email: user.email, isAdmin: user.isAdmin,
      };
      req.userContext = context;
      res.locals.userContext = context;
      if (req.session) {
        // A session issued before switching from direct OIDC may still carry
        // an ID token. Proxy mode has no use for it, even for the same user.
        delete req.session.oidcLogin;
        req.session.userContext = context;
        req.session.externalId = user.externalId;
      }
      return next();
    } catch (error) { next(error); }
  };
}
