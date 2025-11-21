import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/userService';
import { UserContext } from '../types/user';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'local-user';
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Local User';

export function userContextMiddleware(userService: UserService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const externalId = (req.header('x-user-id') || DEFAULT_USER_ID).trim().toLowerCase();
      const displayName = req.header('x-user-name') || DEFAULT_USER_NAME;
      const email = req.header('x-user-email') || undefined;

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
      };

      req.userContext = userContext;
      res.locals.userContext = userContext;
      next();
    } catch (error) {
      next(error);
    }
  };
}
