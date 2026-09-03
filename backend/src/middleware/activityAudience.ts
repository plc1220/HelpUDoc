import { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { UserService, isUserDeactivated } from '../services/userService';
import { resolveActivityScope, type ActivityScope } from '../services/activityService';

declare module 'express-serve-static-core' {
  interface Request {
    activityScope?: ActivityScope;
  }
}

/**
 * Gates the activity feed to platform admins and team leads.
 *
 * A plain member has no activity view, so this is a 403 rather than an empty
 * list — an empty list would read as "nothing happened" instead of "not for
 * you".
 *
 * The scope is resolved here and attached to the request. The route never
 * accepts a scope, a team id, or a user id from the caller: this repo has
 * already shipped a client-side guard that compared an externalId to a database
 * uuid and silently failed open, with the server doing all the real work. Keep
 * the server the only thing that decides.
 */
export function requireActivityAudience(userService: UserService, db: Knex) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }

      // Re-read the user rather than trusting the cached session context, for
      // the same reason `requireSystemAdmin` does: a mid-session deactivation
      // must take effect on the next request, not whenever the session expires.
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

      const scope = await resolveActivityScope(db, latestUser.id);
      if (!scope) {
        return res.status(403).json({ error: 'Activity is available to team leads and administrators' });
      }

      req.activityScope = scope;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
