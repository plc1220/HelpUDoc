import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { UserMemoryService } from '../services/userMemoryService';
import { HttpError } from '../errors';

const updateMemorySchema = z.object({
  scope: z.enum(['global', 'workspace']),
  section: z.enum(['preferences', 'context']),
  workspaceId: z.string().optional(),
  content: z.string(),
});

const decideSuggestionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  editedContent: z.string().optional(),
});

export default function meMemoryRoutes(
  workspaceService: WorkspaceService,
  userMemoryService: UserMemoryService,
) {
  const router = Router();

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

  router.get('/memory', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      if (workspaceId) {
        await workspaceService.ensureMembership(workspaceId, user.userId);
      }
      const memory = await userMemoryService.getMemoryView(user.userId, workspaceId);
      res.json(memory);
    } catch (error) {
      handleError(res, error, 'Failed to load user memory');
    }
  });

  router.patch('/memory', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = updateMemorySchema.parse(req.body);
      if (payload.scope === 'workspace') {
        if (!payload.workspaceId) {
          return res.status(400).json({ error: 'workspaceId is required for workspace memory' });
        }
        await workspaceService.ensureMembership(payload.workspaceId, user.userId, { requireEdit: true });
      }
      const updated = await userMemoryService.updateMemorySection({
        userId: user.userId,
        scope: payload.scope,
        section: payload.section,
        workspaceId: payload.workspaceId,
        content: payload.content,
      });
      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to update user memory');
    }
  });

  router.get('/memory/suggestions', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      if (workspaceId) {
        await workspaceService.ensureMembership(workspaceId, user.userId);
      }
      const suggestions = await userMemoryService.listSuggestions(user.userId, workspaceId);
      res.json(suggestions);
    } catch (error) {
      handleError(res, error, 'Failed to load memory suggestions');
    }
  });

  router.post('/memory/suggestions/:suggestionId/decision', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = decideSuggestionSchema.parse(req.body);
      const suggestion = await userMemoryService.decideSuggestion(
        user.userId,
        req.params.suggestionId,
        payload.decision,
        payload.editedContent,
      );
      res.json(suggestion);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to apply memory suggestion decision');
    }
  });

  return router;
}
