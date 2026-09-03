import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import {
  listRecentActivity,
  MAX_ACTIVITY_PAGE,
} from '../services/activityService';

// The page size is fixed rather than caller-supplied. A feed that reads the
// compliance trail should not take an arbitrary limit, and `page` is the only
// thing a reader actually needs to move.
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_ACTIVITY_PAGE).optional(),
  before: z.string().optional(),
});

export default function activityRoutes(db: Knex) {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const scope = req.activityScope;
      if (!scope) {
        // The gate always sets this. Reaching here means the route was mounted
        // without it, which is a wiring mistake and must not read as "no data".
        return res.status(500).json({ error: 'Activity scope was not resolved' });
      }

      const { page, before } = querySchema.parse(req.query);
      const result = await listRecentActivity(db, scope, { page, before });

      const teamNames = scope.kind === 'teams'
        ? (await db('groups').whereIn('id', scope.teamIds).select('name'))
          .map((row: { name: string }) => String(row.name))
        : [];

      return res.json({
        scope: scope.kind === 'platform'
          ? { kind: 'platform' as const }
          : { kind: 'teams' as const, teamNames },
        ...result,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid activity query' });
      }
      console.error('Failed to load activity', error);
      return res.status(500).json({ error: 'Failed to load activity' });
    }
  });

  return router;
}
