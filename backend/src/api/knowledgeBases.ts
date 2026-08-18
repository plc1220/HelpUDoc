import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { KnowledgeBaseService } from '../services/knowledgeBaseService';

const createSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  ownerTeamId: z.string().uuid(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  ownerTeamId: z.string().uuid().optional(),
});

const addSourceSchema = z.object({ knowledgeSourceId: z.number().int().positive() });

const knowledgeTypes = ['text', 'table', 'image', 'presentation', 'infographic'] as const;
const uploadSessionSchema = z.object({
  fileName: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
  sizeBytes: z.number().int().positive(),
  title: z.string().min(1),
  type: z.enum(knowledgeTypes),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
const publishSchema = z.object({
  version: z.string().trim().max(64).optional(),
  note: z.string().trim().max(2000).optional(),
});

export default function knowledgeBaseRoutes(service: KnowledgeBaseService) {
  const router = Router();

  const userId = (req: Request): string => {
    if (!req.userContext) throw new HttpError(401, 'Missing user context');
    return req.userContext.userId;
  };

  const handle = (res: Response, error: unknown, message: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(message, error);
    return res.status(500).json({ error: message });
  };

  router.get('/catalog', async (req, res) => {
    try { res.json(await service.catalog(userId(req))); }
    catch (error) { handle(res, error, 'Failed to list knowledge bases'); }
  });

  router.get('/mine', async (req, res) => {
    try { res.json(await service.listMine(userId(req))); }
    catch (error) { handle(res, error, 'Failed to list managed knowledge bases'); }
  });

  router.get('/assignable-sources', async (req, res) => {
    try { res.json(await service.assignableSources(userId(req))); }
    catch (error) { handle(res, error, 'Failed to list assignable sources'); }
  });

  router.post('/', async (req, res) => {
    try { res.status(201).json(await service.create(userId(req), createSchema.parse(req.body))); }
    catch (error) { handle(res, error, 'Failed to create knowledge base'); }
  });

  router.get('/:id', async (req, res) => {
    try { res.json(await service.getDetail(userId(req), req.params.id)); }
    catch (error) { handle(res, error, 'Failed to load knowledge base'); }
  });

  router.patch('/:id', async (req, res) => {
    try { res.json(await service.update(userId(req), req.params.id, updateSchema.parse(req.body))); }
    catch (error) { handle(res, error, 'Failed to update knowledge base'); }
  });

  router.post('/:id/sources', async (req, res) => {
    try {
      const { knowledgeSourceId } = addSourceSchema.parse(req.body);
      res.json(await service.addSource(userId(req), req.params.id, knowledgeSourceId));
    } catch (error) { handle(res, error, 'Failed to add source to knowledge base'); }
  });

  router.delete('/:id/sources/:sourceId', async (req, res) => {
    try {
      res.json(await service.removeSource(userId(req), req.params.id, Number(req.params.sourceId)));
    } catch (error) { handle(res, error, 'Failed to remove source from knowledge base'); }
  });

  router.post('/:id/uploads', async (req, res) => {
    try { res.status(201).json(await service.createUploadSession(userId(req), req.params.id, uploadSessionSchema.parse(req.body))); }
    catch (error) { handle(res, error, 'Failed to start knowledge base upload'); }
  });

  router.post('/:id/uploads/:uploadId/complete', async (req, res) => {
    try { res.status(201).json(await service.completeUpload(userId(req), req.params.id, req.params.uploadId)); }
    catch (error) { handle(res, error, 'Failed to finalize knowledge base upload'); }
  });

  router.delete('/:id/uploads/:uploadId', async (req, res) => {
    try { res.json(await service.cancelUpload(userId(req), req.params.id, req.params.uploadId)); }
    catch (error) { handle(res, error, 'Failed to cancel knowledge base upload'); }
  });

  router.post('/:id/publish', async (req, res) => {
    try { res.json(await service.publish(userId(req), req.params.id, publishSchema.parse(req.body ?? {}))); }
    catch (error) { handle(res, error, 'Failed to publish knowledge base'); }
  });

  router.get('/:id/versions', async (req, res) => {
    try { res.json(await service.listVersions(userId(req), req.params.id)); }
    catch (error) { handle(res, error, 'Failed to list knowledge base versions'); }
  });

  router.get('/:id/teams', async (req, res) => {
    try { res.json(await service.listTeamGrants(userId(req), req.params.id)); }
    catch (error) { handle(res, error, 'Failed to list knowledge base team grants'); }
  });

  router.put('/:id/teams/:teamId', async (req, res) => {
    try { res.json(await service.setTeamGrant(userId(req), req.params.id, req.params.teamId, true)); }
    catch (error) { handle(res, error, 'Failed to grant team access'); }
  });

  router.delete('/:id/teams/:teamId', async (req, res) => {
    try { res.json(await service.setTeamGrant(userId(req), req.params.id, req.params.teamId, false)); }
    catch (error) { handle(res, error, 'Failed to revoke team access'); }
  });

  router.post('/:id/archive', async (req, res) => {
    try { res.json(await service.setStatus(userId(req), req.params.id, 'archive')); }
    catch (error) { handle(res, error, 'Failed to archive knowledge base'); }
  });

  router.post('/:id/restore', async (req, res) => {
    try { res.json(await service.setStatus(userId(req), req.params.id, 'restore')); }
    catch (error) { handle(res, error, 'Failed to restore knowledge base'); }
  });

  return router;
}
