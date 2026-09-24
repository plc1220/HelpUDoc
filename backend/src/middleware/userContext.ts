import { Request, Response, NextFunction } from 'express';
import { UserService, isUserDeactivated } from '../services/userService';
import { UserContext } from '../types/user';

type AuthMode = 'headers' | 'oidc' | 'hybrid';

function resolveAuthMode(raw?: string): AuthMode {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'headers' || normalized === 'oidc' || normalized === 'hybrid') {
    return normalized;
  }
  return 'hybrid';
}

export function userContextMiddleware(userService: UserService) {
  // This factory runs after the entrypoint loads ENV_FILE. Reading these values
  // at module evaluation time observes the pre-dotenv environment because ESM/
  // TypeScript imports are evaluated before the entrypoint body.
  const authMode = resolveAuthMode(process.env.AUTH_MODE);
  // Header identity is a local-development convenience, not an authentication
  // mechanism. In production, hybrid mode must not let a caller impersonate
  // another user by sending X-User-Id after clearing their session.
  const allowHeaderAuth = authMode === 'headers'
    || (authMode === 'hybrid' && process.env.NODE_ENV !== 'production');
  const defaultUserName = process.env.DEFAULT_USER_NAME || 'Local User';
  const defaultUserEmail = process.env.DEFAULT_USER_EMAIL || undefined;

  /**
   * A deactivated user is refused here rather than at each route, because this
   * is the only place every authenticated `/api` request passes through. The
   * session is destroyed on the way out so the SPA falls back to the login
   * screen instead of retrying against a context that will never work again.
   */
  const rejectIfDeactivated = async (
    req: Request,
    res: Response,
    userId: string,
  ): Promise<boolean> => {
    if (!await userService.isDeactivated(userId)) {
      return false;
    }
    req.userContext = undefined;
    res.locals.userContext = undefined;
    if (req.session) {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    }
    res.status(403).json({
      error: 'This account has been deactivated. Contact an administrator.',
      code: 'account_deactivated',
    });
    return true;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const useSessionAuth = authMode === 'oidc' || authMode === 'hybrid';
      if (useSessionAuth && req.session?.userContext) {
        // The session carries a snapshot taken at sign-in; status is the one
        // thing that must be re-checked, or deactivating a signed-in user does
        // nothing until their session expires.
        if (await rejectIfDeactivated(req, res, req.session.userContext.userId)) return;
        req.userContext = req.session.userContext;
        res.locals.userContext = req.session.userContext;
        return next();
      }

      if (!allowHeaderAuth) {
        req.userContext = undefined;
        res.locals.userContext = undefined;
        return next();
      }

      const rawExternalId = req.header('x-user-id');
      const externalId = rawExternalId?.trim().toLowerCase() || '';
      if (!externalId) {
        req.userContext = undefined;
        res.locals.userContext = undefined;
        return next();
      }

      if (req.session?.userContext && req.session.externalId === externalId) {
        if (await rejectIfDeactivated(req, res, req.session.userContext.userId)) return;
        req.userContext = req.session.userContext;
        res.locals.userContext = req.session.userContext;
        return next();
      }

      const displayName = req.header('x-user-name') || defaultUserName;
      const email = req.header('x-user-email') || defaultUserEmail;

      const userRecord = await userService.ensureUser({
        externalId,
        displayName,
        email,
      });

      // `ensureUser` upserts by externalId, so in headers mode any request can
      // reach a suspended account's row. It preserves `status`, and this is the
      // gate that acts on it.
      if (isUserDeactivated(userRecord)) {
        if (await rejectIfDeactivated(req, res, userRecord.id)) return;
      }

      const userContext: UserContext = {
        userId: userRecord.id,
        externalId: userRecord.externalId,
        displayName: userRecord.displayName,
        email: userRecord.email,
        isAdmin: userRecord.isAdmin,
      };

      if (req.session) {
        req.session.userContext = userContext;
        req.session.externalId = externalId;
      }

      req.userContext = userContext;
      res.locals.userContext = userContext;
      next();
    } catch (error) {
      next(error);
    }
  };
}
