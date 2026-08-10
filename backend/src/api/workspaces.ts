import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { WorkspacePublicationService } from '../services/workspacePublicationService';
import { UserService } from '../services/userService';
import { ConflictError, HttpError } from '../errors';

const createWorkspaceSchema = z.object({
  name: z.string().trim().max(255).optional(),
});

const renameWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

const namedWorkspaceRoleSchema = z.enum(['publisher', 'contributor', 'viewer']);

const publishWorkspaceSchema = z.object({
  audience: z.enum(['team', 'selected_people']).optional(),
  teamId: z.string().uuid().optional(),
  userIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  role: namedWorkspaceRoleSchema.optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

const shareWorkspaceSchema = z.object({
  userIds: z.array(z.string().uuid()).max(100).optional(),
  teamId: z.string().uuid().optional(),
  role: namedWorkspaceRoleSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  editingPolicy: z.enum(['direct', 'review']).optional(),
}).superRefine((data, ctx) => {
  if (!data.teamId && !data.userIds?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose at least one team or person',
      path: ['teamId'],
    });
  }
});

const workspaceEditingPolicySchema = z.object({
  editingPolicy: z.enum(['direct', 'review']),
});

const transferWorkspaceOwnershipSchema = z.object({
  userId: z.string().uuid(),
}).strict();

const teamAccessSchema = z.object({
  teamId: z.string().uuid(),
  role: z.enum(['contributor', 'viewer']).optional(),
});

const syncWorkspaceSchema = z.object({
  resolutions: z.record(z.string(), z.enum(['private', 'team'])).optional(),
});

const collaboratorSchema = z
  .object({
    userId: z.string().uuid().optional(),
    externalUserId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    role: z.enum(['editor', 'contributor', 'commenter', 'viewer']),
  })
  .superRefine((data, ctx) => {
    if (data.userId && data.externalUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either userId or externalUserId, not both' });
    }
    if (!data.userId && !data.externalUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide userId or externalUserId' });
    }
  });

export default function workspaceRoutes(
  workspaceService: WorkspaceService,
  publicationService: WorkspacePublicationService,
  userService: UserService,
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

  const requireListedWorkspace = async (workspaceId: string, userId: string) => {
    const workspace = (await workspaceService.listWorkspacesForUser(userId))
      .find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new HttpError(500, 'Workspace lifecycle state is unavailable');
    return workspace;
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

  router.get('/teams', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const teams = await workspaceService.listEligibleTeams(user.userId);
      res.json({ teams });
    } catch (error) {
      handleError(res, error, 'Failed to list teams');
    }
  });

  router.post('/:workspaceId/publish', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = publishWorkspaceSchema.parse(req.body || {});
      const publication = await publicationService.publish(req.params.workspaceId, user.userId, payload);
      res.status(201).json(publication);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid publish payload' });
      }
      handleError(res, error, 'Failed to publish workspace');
    }
  });

  router.post('/:workspaceId/publication/withdraw', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const result = await publicationService.withdraw(req.params.workspaceId, user.userId);
      res.json(result);
    } catch (error) {
      handleError(res, error, 'Failed to withdraw publication');
    }
  });

  router.post('/:workspaceId/share', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = shareWorkspaceSchema.parse(req.body || {});
      const shared = await publicationService.shareWithAudience(
        req.params.workspaceId,
        user.userId,
        payload,
      );
      res.status(201).json(shared);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid sharing payload' });
      }
      handleError(res, error, 'Failed to share workspace');
    }
  });

  router.patch('/:workspaceId/editing-policy', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = workspaceEditingPolicySchema.parse(req.body || {});
      await workspaceService.updateEditingPolicy(
        req.params.workspaceId,
        user.userId,
        payload.editingPolicy,
      );
      if (payload.editingPolicy === 'review') {
        await publicationService.createPrivateCopy(req.params.workspaceId, user.userId);
      }
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid editing policy' });
      }
      handleError(res, error, 'Failed to update workspace editing policy');
    }
  });

  router.post('/:workspaceId/private-copy', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspace = await publicationService.createPrivateCopy(req.params.workspaceId, user.userId);
      res.status(201).json(workspace);
    } catch (error) {
      handleError(res, error, 'Failed to create private working copy');
    }
  });

  router.get('/:workspaceId/review-changes', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const changes = await publicationService.getPrivateCopyReviewChanges(
        req.params.workspaceId,
        user.userId,
      );
      res.json(changes);
    } catch (error) {
      handleError(res, error, 'Failed to load private working-copy changes');
    }
  });

  router.post('/:workspaceId/sync', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = syncWorkspaceSchema.parse(req.body || {});
      const result = await publicationService.sync(
        req.params.workspaceId,
        user.userId,
        payload.resolutions || {},
      );
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid sync payload' });
      }
      handleError(res, error, 'Failed to sync team updates');
    }
  });

  // Autosync is deliberately resolution-free. It may fast-forward or merge
  // non-overlapping changes, but overlapping edits are surfaced as a conflict
  // so opening a draft can never silently choose one side.
  router.post('/:workspaceId/autosync', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const result = await publicationService.sync(req.params.workspaceId, user.userId, {});
      if (result.status === 'review_needed') {
        throw new ConflictError('Review overlapping workspace changes before syncing', {
          code: 'REVIEW_NEEDED',
          conflicts: result.conflicts,
        });
      }
      res.json(result);
    } catch (error) {
      handleError(res, error, 'Failed to autosync Shared workspace updates');
    }
  });

  router.post('/:workspaceId/reconnect', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const sync = await publicationService.reconnect(req.params.workspaceId, user.userId);
      const workspace = (await workspaceService.listWorkspacesForUser(user.userId))
        .find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) {
        throw new ConflictError('The private workspace could not be reconnected');
      }
      res.json({ workspace, sync });
    } catch (error) {
      handleError(res, error, 'Failed to reconnect private workspace');
    }
  });

  router.get('/:workspaceId/history', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const versions = await publicationService.listHistory(req.params.workspaceId, user.userId);
      res.json({ versions });
    } catch (error) {
      handleError(res, error, 'Failed to load publication history');
    }
  });

  router.get('/:workspaceId/versions/:versionId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const snapshot = await publicationService.getVersionSnapshot(
        req.params.workspaceId,
        req.params.versionId,
        user.userId,
      );
      res.json(snapshot);
    } catch (error) {
      handleError(res, error, 'Failed to load published version');
    }
  });

  router.get('/:workspaceId/versions/:versionId/file', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const relativePath = req.query.path;
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        return res.status(400).json({ error: 'Missing file path' });
      }
      const file = await publicationService.readVersionFile(
        req.params.workspaceId,
        req.params.versionId,
        relativePath,
        user.userId,
      );
      res.json(file);
    } catch (error) {
      handleError(res, error, 'Failed to load published version file');
    }
  });

  router.post('/:workspaceId/versions/:versionId/restore', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const version = await publicationService.restore(
        req.params.workspaceId,
        req.params.versionId,
        user.userId,
      );
      res.status(201).json(version);
    } catch (error) {
      handleError(res, error, 'Failed to restore published version');
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

  router.delete('/:workspaceId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.deleteWorkspace(req.params.workspaceId, user.userId);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete workspace');
    }
  });

  router.post('/:workspaceId/trash', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.deleteWorkspace(req.params.workspaceId, user.userId);
      const workspace = await requireListedWorkspace(req.params.workspaceId, user.userId);
      res.json({ workspace });
    } catch (error) {
      handleError(res, error, 'Failed to trash workspace');
    }
  });

  router.post('/:workspaceId/unshare', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.unshareWorkspace(req.params.workspaceId, user.userId);
      const workspace = await requireListedWorkspace(req.params.workspaceId, user.userId);
      res.json({ workspace });
    } catch (error) {
      handleError(res, error, 'Failed to unshare workspace');
    }
  });

  router.post('/:workspaceId/reshare', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.reshareWorkspace(req.params.workspaceId, user.userId);
      const workspace = await requireListedWorkspace(req.params.workspaceId, user.userId);
      res.json({ workspace });
    } catch (error) {
      handleError(res, error, 'Failed to reshare workspace');
    }
  });

  router.post('/:workspaceId/restore', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.restoreWorkspace(req.params.workspaceId, user.userId);
      const workspace = await requireListedWorkspace(req.params.workspaceId, user.userId);
      res.json({ workspace });
    } catch (error) {
      handleError(res, error, 'Failed to restore workspace');
    }
  });

  router.post('/:workspaceId/leave', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.leaveWorkspace(req.params.workspaceId, user.userId);
      res.json({ leftWorkspaceId: req.params.workspaceId });
    } catch (error) {
      handleError(res, error, 'Failed to leave workspace');
    }
  });

  router.post('/:workspaceId/transfer-ownership', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = transferWorkspaceOwnershipSchema.parse(req.body || {});
      await workspaceService.transferWorkspaceOwnership(
        req.params.workspaceId,
        user.userId,
        payload.userId,
      );
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid ownership transfer payload' });
      }
      handleError(res, error, 'Failed to transfer workspace ownership');
    }
  });

  router.get('/:workspaceId/collaborators', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const access = await workspaceService.listCollaborators(req.params.workspaceId, user.userId);
      res.json(access);
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

  router.post('/:workspaceId/collaborators/teams', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = teamAccessSchema.parse(req.body);
      await workspaceService.addTeamAccess(
        req.params.workspaceId,
        user.userId,
        payload.teamId,
        payload.role,
      );
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid team access payload' });
      }
      handleError(res, error, 'Failed to add team access');
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

  router.delete('/:workspaceId/collaborators/teams/:teamId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      await workspaceService.removeTeamAccess(req.params.workspaceId, user.userId, req.params.teamId);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to remove team access');
    }
  });

  return router;
}
