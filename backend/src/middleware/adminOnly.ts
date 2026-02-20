import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/userService';

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

      const refreshedContext = {
        ...req.userContext,
        isAdmin: latestUser.isAdmin,
      };

      req.userContext = refreshedContext;
      res.locals.userContext = refreshedContext;
      if (req.session?.userContext) {
        req.session.userContext = refreshedContext;
      }

      if (!latestUser.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
