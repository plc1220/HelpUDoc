import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { KnowledgeService } from '../services/knowledgeService';
import { HttpError } from '../errors';
import { KNOWLEDGE_INGESTION_EVENTS_CHANNEL, redisClient } from '../services/redisService';

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
  const searchSchema = z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(30).optional(),
    graphHops: z.number().int().min(0).max(2).optional(),
    includeAmbiguous: z.boolean().optional(),
    vector: z.boolean().optional(),
  });
  const evidenceSchema = z.object({
    blockIds: z.array(z.string().min(1)).min(1).max(100),
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

  router.get('/ingestions', async (_req: Request, res: Response) => {
    try {
      const jobs = global
        ? await knowledgeService.listGlobalIngestionJobs()
        : [];
      res.json(jobs);
    } catch (error) {
      handleError(res, error, 'Failed to list knowledge ingestion jobs');
    }
  });

  router.get('/ingestion-events', async (req: Request, res: Response) => {
    let subscriber: ReturnType<typeof redisClient.duplicate> | null = null;
    let keepAlive: NodeJS.Timeout | null = null;
    let closed = false;
    try {
      const user = requireUserContext(req);
      if (!user) return;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.write(': connected\n\n');

      subscriber = redisClient.duplicate();
      subscriber.on('error', (error) => {
        if (!closed) console.error('Knowledge ingestion event subscriber error', error);
      });
      await subscriber.connect();
      await subscriber.subscribe(KNOWLEDGE_INGESTION_EVENTS_CHANNEL, (message) => {
        if (closed) return;
        try {
          const event = JSON.parse(message) as { workspaceId?: string };
          // The global route is system-admin protected; workspace routes should
          // only receive events from their own workspace.
          const requestedWorkspaceId = req.params.workspaceId;
          if (requestedWorkspaceId && event.workspaceId !== requestedWorkspaceId) return;
          res.write(`event: knowledge-ingestion\ndata: ${message}\n\n`);
        } catch {
          // Ignore malformed notification payloads; the database polling fallback remains available.
        }
      });
      keepAlive = setInterval(() => {
        if (!closed) res.write(': keep-alive\n\n');
      }, 15_000);
      keepAlive.unref();
      req.on('close', () => {
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        void subscriber?.unsubscribe().catch(() => undefined);
        void subscriber?.quit().catch(() => undefined);
      });
    } catch (error) {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      if (!res.headersSent) {
        handleError(res, error, 'Failed to subscribe to knowledge ingestion events');
      } else {
        res.end();
      }
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
      const bundle = global
        ? await knowledgeService.getGlobalBundle(id, user.userId)
        : await knowledgeService.getBundle(req.params.workspaceId as string, id, user.userId);
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
      const file = global
        ? await knowledgeService.readGlobalBundleFile(id, user.userId, relativePath)
        : await knowledgeService.readWorkspaceBundleFile(
            req.params.workspaceId as string,
            id,
            user.userId,
            relativePath,
          );
      res.json(file);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge bundle file');
    }
  });

  router.post('/:knowledgeId/search', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const { query, ...searchOptions } = searchSchema.parse(req.body);
      const result = global
        ? await knowledgeService.searchGlobalKnowledge(id, user.userId, query, searchOptions)
        : await knowledgeService.searchKnowledge(workspaceId as string, id, user.userId, query, searchOptions);
      res.json(result);
    } catch (error) {
      handleError(res, error, 'Failed to search Knowledge');
    }
  });

  router.post('/:knowledgeId/evidence', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const { blockIds } = evidenceSchema.parse(req.body);
      const result = global
        ? await knowledgeService.readGlobalEvidence(id, user.userId, blockIds)
        : await knowledgeService.readKnowledgeEvidence(workspaceId as string, id, user.userId, blockIds);
      res.json({ blockIds, evidence: result });
    } catch (error) {
      handleError(res, error, 'Failed to read Knowledge evidence');
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

  router.post('/:knowledgeId/ingestions', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const item = global
        ? await knowledgeService.rebuildGlobal(id, user.userId)
        : await knowledgeService.rebuild(workspaceId as string, id, user.userId);
      res.status(202).json(item);
    } catch (error) {
      handleError(res, error, 'Failed to start knowledge ingestion');
    }
  });

  router.get('/:knowledgeId/ingestions/current', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const job = global
        ? await knowledgeService.getGlobalIngestionCurrent(id)
        : await knowledgeService.getIngestionCurrent(workspaceId as string, id, user.userId);
      res.json(job);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge ingestion');
    }
  });

  router.get('/:knowledgeId/ingestions/preview', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const preview = global
        ? await knowledgeService.previewGlobalIngestion(id, user.userId)
        : await knowledgeService.previewIngestionCost(workspaceId as string, id, user.userId);
      res.json(preview);
    } catch (error) {
      handleError(res, error, 'Failed to preview Knowledge ingestion');
    }
  });

  router.get('/:knowledgeId/ingestions/:runId/report', async (req: Request<{ workspaceId?: string; knowledgeId: string; runId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId, runId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const report = global
        ? await knowledgeService.getGlobalIngestionReport(id, runId)
        : await knowledgeService.getIngestionReport(workspaceId as string, id, runId, user.userId);
      res.json(report);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge ingestion report');
    }
  });

  router.post('/:knowledgeId/ingestions/:runId/cancel', async (req: Request<{ workspaceId?: string; knowledgeId: string; runId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId, runId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const job = global
        ? await knowledgeService.cancelGlobalIngestion(id, runId)
        : await knowledgeService.cancelIngestion(workspaceId as string, id, runId, user.userId);
      res.json(job);
    } catch (error) {
      handleError(res, error, 'Failed to cancel knowledge ingestion');
    }
  });

  router.post('/:knowledgeId/ingestions/:runId/retry', async (req: Request<{ workspaceId?: string; knowledgeId: string; runId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const item = global
        ? await knowledgeService.rebuildGlobal(id, user.userId)
        : await knowledgeService.rebuild(workspaceId as string, id, user.userId);
      res.status(202).json(item);
    } catch (error) {
      handleError(res, error, 'Failed to retry knowledge ingestion');
    }
  });

  router.get('/:knowledgeId/snapshots', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const snapshots = global
        ? await knowledgeService.listGlobalSnapshots(id)
        : await knowledgeService.listKnowledgeSnapshots(workspaceId as string, id, user.userId);
      res.json(snapshots);
    } catch (error) {
      handleError(res, error, 'Failed to list Knowledge snapshots');
    }
  });

  router.post('/:knowledgeId/snapshots/:snapshotId/publish', async (req: Request<{ workspaceId?: string; knowledgeId: string; snapshotId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId, snapshotId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const result = global
        ? await knowledgeService.publishGlobalSnapshot(id, snapshotId, user.userId)
        : await knowledgeService.publishKnowledgeSnapshot(workspaceId as string, id, snapshotId, user.userId);
      res.json(result);
    } catch (error) {
      handleError(res, error, 'Failed to publish Knowledge snapshot');
    }
  });

  router.get('/:knowledgeId/graph', async (req: Request<{ workspaceId?: string; knowledgeId: string }>, res: Response) => {
    try {
      const { workspaceId, knowledgeId } = req.params;
      const user = requireUserContext(req);
      const id = parseInt(knowledgeId, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid knowledge id' });
      const graph = global
        ? await knowledgeService.getGlobalGraph(id)
        : await knowledgeService.getGraph(workspaceId as string, id, user.userId);
      res.json(graph);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve knowledge graph');
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
