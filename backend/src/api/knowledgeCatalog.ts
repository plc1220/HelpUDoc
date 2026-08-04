import { Router, type Request, type Response } from 'express';
import { HttpError } from '../errors';
import type { KnowledgeService } from '../services/knowledgeService';

export default function knowledgeCatalogRoutes(knowledgeService: KnowledgeService) {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      if (!req.userContext) throw new HttpError(401, 'Missing user context');
      res.json(await knowledgeService.listAccessibleGlobal(req.userContext.userId));
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to list accessible Knowledge', error);
      return res.status(500).json({ error: 'Failed to list accessible Knowledge' });
    }
  });

  return router;
}
