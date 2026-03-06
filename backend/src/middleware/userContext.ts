import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/userService';
import { UserContext } from '../types/user';

const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Local User';
const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL || undefined;
type AuthMode = 'headers' | 'oidc' | 'hybrid';

function resolveAuthMode(raw?: string): AuthMode {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'headers' || normalized === 'oidc' || normalized === 'hybrid') {
    return normalized;
  }
  return 'hybrid';
}

const AUTH_MODE = resolveAuthMode(process.env.AUTH_MODE);

export function userContextMiddleware(userService: UserService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const useSessionAuth = AUTH_MODE === 'oidc' || AUTH_MODE === 'hybrid';
      if (useSessionAuth && req.session?.userContext) {
        req.userContext = req.session.userContext;
        res.locals.userContext = req.session.userContext;
        return next();
      }

      if (AUTH_MODE === 'oidc') {
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
        req.userContext = req.session.userContext;
        res.locals.userContext = req.session.userContext;
        return next();
      }

      const displayName = req.header('x-user-name') || DEFAULT_USER_NAME;
      const email = req.header('x-user-email') || DEFAULT_USER_EMAIL;

      const userRecord = await userService.ensureUser({
        externalId,
        displayName,
        email,
      });

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
