import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { SkillEvolutionService } from '../services/skillEvolutionService';
import { HttpError } from '../errors';

const decideSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  editedContent: z.string().optional(),
});

const generateSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

export default function settingsSkillEvolutionRoutes(skillEvolutionService: SkillEvolutionService) {
  const router = Router();

  const requireUser = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const handleError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
  };

  router.get('/suggestions', async (req, res) => {
    try {
      requireUser(req);
      const raw = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const allowed = new Set(['pending', 'accepted', 'rejected', 'stale', 'all']);
      const status = allowed.has(raw) ? raw : 'pending';
      const suggestions = await skillEvolutionService.listSuggestions(status);
      res.json(suggestions);
    } catch (error) {
      handleError(res, error, 'Failed to list skill evolution suggestions');
    }
  });

  router.post('/suggestions/:id/decision', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = decideSchema.parse(req.body);
      const suggestion = await skillEvolutionService.decideSuggestion(
        user.userId,
        req.params.id,
        payload.decision,
        payload.editedContent,
      );
      res.json(suggestion);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to apply skill evolution decision');
    }
  });

  router.post('/generate', async (req, res) => {
    try {
      requireUser(req);
      const body = generateSchema.safeParse(req.body || {});
      const limit = body.success && body.data.limit ? body.data.limit : 40;
      const result = await skillEvolutionService.generateManual(limit);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to generate skill evolution suggestions');
    }
  });

  return router;
}
