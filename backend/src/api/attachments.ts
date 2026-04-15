import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { AttachmentPrepJobService } from '../services/attachmentPrepJobService';
import { HttpError } from '../errors';

export default function attachmentRoutes(
  workspaceService: WorkspaceService,
  attachmentPrepJobService: AttachmentPrepJobService,
) {
  const router = Router({ mergeParams: true });

  const createJobSchema = z.object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    driveFileIds: z.array(z.string().min(1)).optional(),
    sourceFileIds: z.array(z.number().int().positive()).optional(),
  });

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

  router.post('/jobs', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const payload = createJobSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const job = await attachmentPrepJobService.createJob({
        workspaceId,
        conversationId: payload.conversationId,
        turnId: payload.turnId,
        userId: user.userId,
        driveFileIds: payload.driveFileIds,
        sourceFileIds: payload.sourceFileIds,
      });
      res.status(201).json(job);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid attachment prep payload' });
      }
      handleError(res, error, 'Failed to create attachment prep job');
    }
  });

  router.get('/jobs/:jobId', async (req: Request<{ workspaceId: string; jobId: string }>, res: Response) => {
    try {
      const { workspaceId, jobId } = req.params;
      const user = requireUserContext(req);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const job = await attachmentPrepJobService.getJob(jobId, user.userId);
      res.json(job);
    } catch (error) {
      handleError(res, error, 'Failed to fetch attachment prep job');
    }
  });

  return router;
}
