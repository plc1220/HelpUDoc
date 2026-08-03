import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { KnowledgeService } from '../services/knowledgeService';
import { HttpError } from '../errors';

const knowledgeTypes = ['text', 'table', 'image', 'presentation', 'infographic'] as const;

export default function(knowledgeService: KnowledgeService, options: { global?: boolean } = {}) {
  const router = Router({ mergeParams: true });
  const global = Boolean(options.global);
  const upload = multer({ storage: multer.memoryStorage() });

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

  router.get('/', async (req: Request<{ workspaceId?: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const items = global
        ? await knowledgeService.listGlobal()
        : await knowledgeService.list(workspaceId as string, user.userId);
      res.json(items);
    } catch (error) {
      handleError(res, error, 'Failed to list knowledge sources');
    }
  });

  router.get('/:knowledgeId', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      const item = global
        ? await knowledgeService.getGlobalById(id)
        : await knowledgeService.getById(workspaceId as string, id, user.userId);
      res.json(item);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge source');
    }
  });

  router.get('/:knowledgeId/bundle', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      if (!global) {
        return res.status(404).json({ error: 'Knowledge bundle inspector is only available in the admin catalog' });
      }
      const bundle = await knowledgeService.getGlobalBundle(id, user.userId);
      res.json(bundle);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge bundle');
    }
  });

  router.get('/:knowledgeId/bundle/file', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      const relativePath = req.query.path;
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        return res.status(400).json({ error: 'Missing bundle file path' });
      }
      if (!global) {
        return res.status(404).json({ error: 'Knowledge bundle inspector is only available in the admin catalog' });
      }
      const file = await knowledgeService.readGlobalBundleFile(id, user.userId, relativePath);
      res.json(file);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge bundle file');
    }
  });

  router.post('/', async (req: Request<{ workspaceId?: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const payload = createSchema.parse(req.body);
      const item = global
        ? await knowledgeService.createGlobal(user.userId, payload)
        : await knowledgeService.create(workspaceId as string, user.userId, payload);
      res.status(201).json(item);
    } catch (error) {
      handleError(res, error, 'Failed to create knowledge source');
    }
  });

  router.put('/:knowledgeId', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
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
      const item = global
        ? await knowledgeService.updateGlobal(id, user.userId, payload)
        : await knowledgeService.update(workspaceId as string, id, user.userId, payload);
      res.json(item);
    } catch (error) {
      handleError(res, error, 'Failed to update knowledge source');
    }
  });

  router.post('/:knowledgeId/ingest', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      const item = global
        ? await knowledgeService.rebuildGlobal(id, user.userId)
        : await knowledgeService.rebuild(workspaceId as string, id, user.userId);
      res.status(202).json(item);
    } catch (error) {
      handleError(res, error, 'Failed to start knowledge ingestion');
    }
  });

  router.delete('/:knowledgeId', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid knowledge id' });
      }
      if (global) {
        await knowledgeService.deleteGlobal(id, user.userId);
      } else {
        await knowledgeService.delete(workspaceId as string, id, user.userId);
      }
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete knowledge source');
    }
  });

  if (global) {
    router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
      try {
        const user = requireUserContext(req);
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        const payload = createSchema.parse({
          title: req.body.title || req.file.originalname,
          type: req.body.type,
          description: req.body.description,
          metadata: req.body.metadata ? JSON.parse(req.body.metadata) : undefined,
        });
        const item = await knowledgeService.createGlobalUpload(user.userId, req.file, payload);
        return res.status(201).json(item);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid knowledge upload payload' });
        }
        handleError(res, error, 'Failed to upload knowledge source');
      }
    });
  }

  return router;
}
