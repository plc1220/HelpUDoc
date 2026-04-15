import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { UserService } from '../services/userService';
import { HttpError } from '../errors';

const createWorkspaceSchema = z.object({
  name: z.string().trim().max(255).optional(),
});

const renameWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

const collaboratorSchema = z
  .object({
    userId: z.string().uuid().optional(),
    externalUserId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    role: z.enum(['editor', 'viewer']),
  })
  .superRefine((data, ctx) => {
    if (data.userId && data.externalUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either userId or externalUserId, not both' });
    }
    if (!data.userId && !data.externalUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide userId or externalUserId' });
    }
  });

const workspaceSettingsSchema = z.object({
  skipPlanApprovals: z.boolean(),
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

  router.get('/user-directory', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
      const excludeSelf =
        req.query.excludeSelf === '1' || req.query.excludeSelf === 'true' || req.query.excludeSelf === 'yes';
      const users = await userService.searchUsersForDirectory(q, {
        limit,
        excludeUserId: excludeSelf ? user.userId : undefined,
      });
      res.json({ users });
    } catch (error) {
      handleError(res, error, 'Failed to search users');
    }
  });

  router.patch('/:workspaceId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = renameWorkspaceSchema.parse(req.body);
      const workspace = await workspaceService.renameWorkspace(req.params.workspaceId, user.userId, payload.name);
      res.json(workspace);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid workspace payload' });
      }
      handleError(res, error, 'Failed to rename workspace');
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

  router.get('/:workspaceId/settings', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const settings = await workspaceService.getWorkspaceSettings(req.params.workspaceId, user.userId);
      res.json(settings);
    } catch (error) {
      handleError(res, error, 'Failed to load workspace settings');
    }
  });

  router.patch('/:workspaceId/settings', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = workspaceSettingsSchema.parse(req.body);
      const settings = await workspaceService.updateWorkspaceSettings(req.params.workspaceId, user.userId, payload);
      res.json(settings);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid workspace settings payload' });
      }
      handleError(res, error, 'Failed to update workspace settings');
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
      if (payload.userId) {
        if (payload.userId === user.userId) {
          throw new HttpError(400, 'Cannot invite yourself');
        }
        const target = await userService.getUserById(payload.userId);
        if (!target) {
          throw new HttpError(404, 'User not found');
        }
        await workspaceService.addCollaborator(req.params.workspaceId, user.userId, target.id, payload.role);
      } else if (payload.externalUserId) {
        const collaborator = await userService.ensureUser({
          externalId: payload.externalUserId,
          displayName: payload.displayName || payload.externalUserId,
        });
        if (collaborator.id === user.userId) {
          throw new HttpError(400, 'Cannot invite yourself');
        }
        await workspaceService.addCollaborator(req.params.workspaceId, user.userId, collaborator.id, payload.role);
      }
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid collaborator payload' });
      }
      handleError(res, error, 'Failed to add collaborator');
    }
  });

  router.delete('/:workspaceId/collaborators/:targetUserId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.removeCollaborator(
        req.params.workspaceId,
        user.userId,
        req.params.targetUserId,
      );
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to remove collaborator');
    }
  });

  return router;
}
