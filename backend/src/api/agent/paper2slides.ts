import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Paper2SlidesService } from '../../services/paper2SlidesService';
import type { Paper2SlidesJobService } from '../../services/paper2SlidesJobService';
import { HttpError } from '../../errors';

const presentationSchema = z.object({
  workspaceId: z.string().min(1),
  fileIds: z.array(z.number().int().positive()).min(1),
  brief: z.string().optional(),
  persona: z.string().min(1).optional(),
  output: z.enum(['slides', 'poster']).optional(),
  content: z.enum(['paper', 'general']).optional(),
  style: z.string().optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
  mode: z.enum(['fast', 'normal']).optional(),
  parallel: z.union([z.number().int().positive(), z.boolean()]).optional(),
  fromStage: z.enum(['rag', 'analysis', 'summary', 'plan', 'generate']).optional(),
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

export function registerPaper2SlidesRoutes(
  router: Router,
  paper2SlidesService: Paper2SlidesService,
  paper2SlidesJobService: Paper2SlidesJobService,
) {
  router.post('/paper2slides/jobs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const {
        workspaceId,
        fileIds,
        brief,
        persona,
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
      } = presentationSchema.parse(req.body);

      const job = await paper2SlidesJobService.createJob({
        workspaceId,
        userId: user.userId,
        fileIds,
        brief,
        persona,
        options: {
          output,
          content,
          style,
          length,
          mode,
          parallel,
          fromStage,
        },
      });

      res.json({ jobId: job.id, status: job.status, createdAt: job.createdAt });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to start Paper2Slides job');
    }
  });

  router.get('/paper2slides/jobs/:jobId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { jobId } = req.params;
      const job = await paper2SlidesJobService.getJob(jobId, user.userId);
      res.json({
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error: any) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to fetch Paper2Slides job');
    }
  });
}
