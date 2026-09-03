import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { UserService } from '../services/userService';
import { resolveActivityScope } from '../services/activityService';
import { HttpError } from '../errors';

const lastWorkspaceSchema = z.object({
  workspaceId: z.string().uuid().nullable(),
});

/**
 * Self-service preferences for the signed-in user. Distinct from `users.ts`, which
 * is mounted behind `requireSystemAdmin` — nothing here is an admin operation.
 */
export default function mePreferencesRoutes(userService: UserService, db: Knex) {
  const router = Router();

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  /**
   * Returns the bare id and nothing else. It is opaque: it discloses nothing the
   * caller did not themselves write, and it is not evidence of access — the client
   * must resolve it against `GET /api/workspaces` before opening it. Keep the
   * response shape free of workspace fields so there is nothing to accidentally
   * trust.
   */
  router.get('/last-workspace', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = await userService.getLastWorkspaceId(user.userId);
      return res.json({ workspaceId });
    } catch (error) {
      return handleError(res, error, 'Failed to load last workspace preference');
    }
  });

  /**
   * Only the shape is validated, not the caller's access to the workspace. A
   * write-time membership check could not replace the read-time one — access can
   * be revoked between the two — so it would duplicate a check that has to exist
   * anyway, while adding a silent failure mode to a fire-and-forget call.
   */
  router.put('/last-workspace', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { workspaceId } = lastWorkspaceSchema.parse(req.body);
      // The DB uuid comes from the request context. A client-supplied user id is
      // never accepted: on the frontend `AuthUser.id` is the externalId, and
      // conflating the two is what made the users-page self-action guard fail open.
      await userService.setLastWorkspaceId(user.userId, workspaceId);
      return res.json({ workspaceId });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      return handleError(res, error, 'Failed to save last workspace preference');
    }
  });

  /**
   * What this user is allowed to reach, so the client can hide a control rather
   * than show one that 403s. It is a convenience for the interface only — every
   * endpoint still enforces its own access, and nothing here grants anything.
   */
  router.get('/capabilities', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const scope = await resolveActivityScope(db, user.userId);
      return res.json({
        canViewActivity: scope !== null,
        activityScope: scope === null ? null : scope.kind,
      });
    } catch (error) {
      return handleError(res, error, 'Failed to load capabilities');
    }
  });

  return router;
}
