import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../errors';
import type { GcsBucketRegistryService } from '../../services/gcsBucketRegistryService';

/**
 * Admin management of the Cloud Storage buckets users may import from. Mounted
 * under `/api/settings`, which `routes.ts` already puts behind
 * `requireSystemAdmin`, so these handlers add no guard of their own.
 */

const bucketInputSchema = z.object({
  bucketName: z.string().min(1).max(222),
  pathPrefix: z.string().max(512).optional(),
  displayName: z.string().max(128).optional(),
  description: z.string().max(512).nullable().optional(),
  defaultAccess: z.enum(['allow', 'deny']).optional(),
});

const bucketPatchSchema = z.object({
  pathPrefix: z.string().max(512).optional(),
  displayName: z.string().min(1).max(128).optional(),
  description: z.string().max(512).nullable().optional(),
  defaultAccess: z.enum(['allow', 'deny']).optional(),
  isArchived: z.boolean().optional(),
});

const grantsSchema = z.object({
  grants: z.array(z.object({
    teamId: z.string().uuid(),
    effect: z.enum(['allow', 'deny']),
  })).max(200),
});

export function registerGcsBucketRoutes(
  router: Router,
  gcsBucketRegistryService: GcsBucketRegistryService,
): void {
  const requireUserId = (req: Request): string => {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new HttpError(401, 'Missing user context');
    }
    return userId;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: fallbackMessage });
    }
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  router.get('/gcs-buckets', async (req: Request, res: Response) => {
    try {
      const includeArchived = String(req.query.includeArchived || '') === 'true';
      const buckets = await gcsBucketRegistryService.listAll({ includeArchived });
      res.json({ buckets });
    } catch (error) {
      handleError(res, error, 'Failed to list Cloud Storage bucket registrations');
    }
  });

  router.post('/gcs-buckets', async (req: Request, res: Response) => {
    try {
      const payload = bucketInputSchema.parse(req.body);
      const bucket = await gcsBucketRegistryService.create(payload, requireUserId(req));
      res.status(201).json({ bucket });
    } catch (error) {
      handleError(res, error, 'Failed to register Cloud Storage bucket');
    }
  });

  router.patch('/gcs-buckets/:bucketId', async (req: Request<{ bucketId: string }>, res: Response) => {
    try {
      const payload = bucketPatchSchema.parse(req.body);
      const bucket = await gcsBucketRegistryService.update(req.params.bucketId, payload);
      res.json({ bucket });
    } catch (error) {
      handleError(res, error, 'Failed to update Cloud Storage bucket registration');
    }
  });

  /**
   * Archives rather than deletes. The grants an admin built up survive, and a
   * mistaken removal is undone with a single PATCH — the same bargain the skill
   * catalog makes.
   */
  router.delete('/gcs-buckets/:bucketId', async (req: Request<{ bucketId: string }>, res: Response) => {
    try {
      const bucket = await gcsBucketRegistryService.archive(req.params.bucketId);
      res.json({ bucket });
    } catch (error) {
      handleError(res, error, 'Failed to archive Cloud Storage bucket registration');
    }
  });

  router.put('/gcs-buckets/:bucketId/grants', async (req: Request<{ bucketId: string }>, res: Response) => {
    try {
      const payload = grantsSchema.parse(req.body);
      const bucket = await gcsBucketRegistryService.replaceTeamGrants(
        req.params.bucketId,
        payload.grants,
        requireUserId(req),
      );
      res.json({ bucket });
    } catch (error) {
      handleError(res, error, 'Failed to update Cloud Storage bucket grants');
    }
  });
}
