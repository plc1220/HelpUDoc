import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/userService';
import { UserContext } from '../types/user';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'local-user';
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Local User';
const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL || undefined;
const AUTH_MODE = (process.env.AUTH_MODE || 'oidc').trim().toLowerCase();

export function userContextMiddleware(userService: UserService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (AUTH_MODE !== 'headers') {
        if (req.session?.userContext) {
          req.userContext = req.session.userContext;
          res.locals.userContext = req.session.userContext;
        } else {
          req.userContext = undefined;
          res.locals.userContext = undefined;
        }
        return next();
      }

      const externalId = (req.header('x-user-id') || DEFAULT_USER_ID).trim().toLowerCase();
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
