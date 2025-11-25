import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { KnowledgeService } from '../services/knowledgeService';
import { HttpError } from '../errors';

const knowledgeTypes = ['text', 'table', 'image', 'presentation', 'infographic'] as const;

export default function(knowledgeService: KnowledgeService) {
  const router = Router({ mergeParams: true });

  const createSchema = z.object({
    title: z.string().min(1),
    type: z.enum(knowledgeTypes),
    description: z.string().optional(),
    content: z.string().optional(),
    fileId: z.number().int().positive().optional(),
    sourceUrl: z.string().url().optional(),
    tags: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  });

  const updateSchema = createSchema.partial();

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

  router.get('/', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const items = await knowledgeService.list(workspaceId, user.userId);
      res.json(items);
    } catch (error) {
      handleError(res, error, 'Failed to list knowledge sources');
    }
  });

  router.get('/:knowledgeId', async (req: Request<{ workspaceId: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      const item = await knowledgeService.getById(workspaceId, id, user.userId);
      res.json(item);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge source');
    }
  });

  router.post('/', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const payload = createSchema.parse(req.body);
      const item = await knowledgeService.create(workspaceId, user.userId, payload);
      res.status(201).json(item);
    } catch (error) {
      handleError(res, error, 'Failed to create knowledge source');
    }
  });

  router.put('/:knowledgeId', async (req: Request<{ workspaceId: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const payload = updateSchema.parse(req.body);
      if (!Object.keys(payload).length) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      const item = await knowledgeService.update(
        workspaceId,
        id,
        user.userId,
        payload,
      );
      res.json(item);
    } catch (error) {
      handleError(res, error, 'Failed to update knowledge source');
    }
  });

  router.delete('/:knowledgeId', async (req: Request<{ workspaceId: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      await knowledgeService.delete(workspaceId, id, user.userId);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete knowledge source');
    }
  });

  return router;
}
