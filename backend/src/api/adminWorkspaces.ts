import { Router } from 'express';
import { z } from 'zod';
import type { WorkspaceService } from '../services/workspaceService';
import type { FileService } from '../services/fileService';
import { HttpError } from '../errors';

/**
 * Read-only oversight of every workspace on the platform, for platform admins.
 *
 * **Every route here is a GET, and that is the control, not a convention.** An
 * admin needs to see what exists in order to govern it; nothing about that
 * requires the ability to change it. Keeping the mutation surface empty means a
 * mistake here cannot damage a workspace, and the underlying
 * `ensureMembership` override independently resolves to `viewer` for any
 * workspace a person owns — so the guarantee holds even if a future route
 * forgets it.
 *
 * Reads that cross a membership boundary are audited by `ensureMembership`
 * itself, at the funnel, rather than by each handler remembering to.
 */
const listWorkspacesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
  search: z.string().max(200).optional(),
  status: z.enum(['active', 'unshared', 'trashed', 'purged']).optional(),
  visibility: z.enum(['private', 'team']).optional(),
  ownerId: z.string().uuid().optional(),
  includePurged: z.coerce.boolean().optional(),
});

const handleError = (res: any, error: unknown, fallback: string) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message, details: error.details });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
};

export default function adminWorkspaceRoutes(
  workspaceService: WorkspaceService,
  fileService: FileService,
) {
  const router = Router();

  const requireUser = (req: any, res: any): string | null => {
    if (!req.userContext) {
      res.status(401).json({ error: 'Missing user context' });
      return null;
    }
    return req.userContext.userId as string;
  };

  router.get('/', async (req, res) => {
    try {
      if (!requireUser(req, res)) return;
      const options = listWorkspacesSchema.parse(req.query);
      const result = await workspaceService.listAllWorkspacesForAdmin(options);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid workspace list query' });
      }
      handleError(res, error, 'Failed to list workspaces');
    }
  });

  router.get('/:workspaceId', async (req, res) => {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const { workspace, membership } = await workspaceService.ensureMembership(
        req.params.workspaceId,
        userId,
        { allowSystemAdmin: true },
      );
      const access = await workspaceService.listCollaborators(req.params.workspaceId, userId, {
        allowSystemAdmin: true,
      });
      res.json({
        workspace,
        // Surfaced so the UI can say plainly that this is an override read, and
        // never render an editing affordance that the API would reject anyway.
        viewingAsAdmin: membership.role === 'viewer' && !membership.canEdit,
        collaborators: access.collaborators,
        teams: access.teams,
      });
    } catch (error) {
      handleError(res, error, 'Failed to load workspace');
    }
  });

  router.get('/:workspaceId/files', async (req, res) => {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const files = await fileService.getFiles(req.params.workspaceId, userId, {
        allowSystemAdmin: true,
      });
      res.json({ files });
    } catch (error) {
      handleError(res, error, 'Failed to list workspace files');
    }
  });

  router.get('/:workspaceId/files/:fileId/content', async (req, res) => {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const fileId = Number(req.params.fileId);
      if (!Number.isFinite(fileId)) {
        return res.status(400).json({ error: 'Invalid file id' });
      }
      const file = await fileService.readFileForAdmin(req.params.workspaceId, fileId, userId);
      res.json(file);
    } catch (error) {
      handleError(res, error, 'Failed to read file');
    }
  });

  router.get('/:workspaceId/conversations', async (req, res) => {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const conversations = await workspaceService.listConversationsForAdmin(
        req.params.workspaceId,
        userId,
      );
      res.json({ conversations });
    } catch (error) {
      handleError(res, error, 'Failed to list workspace conversations');
    }
  });

  router.get('/:workspaceId/conversations/:conversationId', async (req, res) => {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const conversation = await workspaceService.readConversationForAdmin(
        req.params.workspaceId,
        req.params.conversationId,
        userId,
      );
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json(conversation);
    } catch (error) {
      handleError(res, error, 'Failed to read conversation');
    }
  });

  return router;
}
