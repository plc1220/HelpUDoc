import { Request, Response, NextFunction } from 'express';
import { UserService, isUserDeactivated } from '../services/userService';

export function requireSystemAdmin(userService: UserService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }

      const latestUser = await userService.getUserById(req.userContext.userId);
      if (!latestUser) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (isUserDeactivated(latestUser)) {
        return res.status(403).json({
          error: 'This account has been deactivated. Contact an administrator.',
          code: 'account_deactivated',
        });
      }

      // `isPlatformAdmin` rather than the bare `isAdmin` column: the governance
      // services already honour a `platform_role_bindings` row, and an admin who
      // passes there but fails here is a confusing half-privilege.
      const isAdmin = await userService.isPlatformAdmin(latestUser.id);

      const refreshedContext = {
        ...req.userContext,
        isAdmin,
      };

      req.userContext = refreshedContext;
      res.locals.userContext = refreshedContext;
      if (req.session?.userContext) {
        req.session.userContext = refreshedContext;
      }

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
