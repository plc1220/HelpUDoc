import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { UserService } from '../services/userService';
import { HttpError } from '../errors';

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
});

const collaboratorSchema = z.object({
  externalUserId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  role: z.enum(['editor', 'viewer']),
});

export default function workspaceRoutes(workspaceService: WorkspaceService, userService: UserService) {
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

  router.get('/', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaces = await workspaceService.listWorkspacesForUser(user.userId);
      res.json(workspaces);
    } catch (error) {
      handleError(res, error, 'Failed to list workspaces');
    }
  });

  router.post('/', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { name } = createWorkspaceSchema.parse(req.body);
      const newWorkspace = await workspaceService.createWorkspace(user, name);
      res.status(201).json(newWorkspace);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to create workspace');
    }
  });

  router.get('/:workspaceId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspace = await workspaceService.getWorkspaceForUser(req.params.workspaceId, user.userId);
      res.json(workspace);
    } catch (error) {
      handleError(res, error, 'Failed to load workspace');
    }
  });

  router.delete('/:workspaceId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.deleteWorkspace(req.params.workspaceId, user.userId);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete workspace');
    }
  });

  router.get('/:workspaceId/collaborators', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const collaborators = await workspaceService.listCollaborators(req.params.workspaceId, user.userId);
      res.json({ collaborators });
    } catch (error) {
      handleError(res, error, 'Failed to list collaborators');
    }
  });

  router.post('/:workspaceId/collaborators', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = collaboratorSchema.parse(req.body);
      const collaborator = await userService.ensureUser({
        externalId: payload.externalUserId,
        displayName: payload.displayName || payload.externalUserId,
      });
      await workspaceService.addCollaborator(req.params.workspaceId, user.userId, collaborator.id, payload.role);
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid collaborator payload' });
      }
      handleError(res, error, 'Failed to add collaborator');
    }
  });

  return router;
}
