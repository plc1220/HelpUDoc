import { Router } from 'express';
import { z } from 'zod';
import { UserService } from '../services/userService';
import { HttpError } from '../errors';
import { findUnknownRuntimeMcpServerIds, loadRuntimeMcpServers } from './agent/policy';

const updateAdminSchema = z.object({
  isAdmin: z.boolean(),
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(128),
});

const groupMemberSchema = z.object({
  userId: z.string().uuid(),
});

const groupPromptAccessSchema = z.object({
  skillIds: z.array(z.string().min(1)).default([]),
  mcpServerIds: z.array(z.string().min(1)).default([]),
  knowledgeBaseIds: z.array(z.string().uuid()).default([]),
});

const deactivateUserSchema = z.object({
  reason: z.string().max(2000).optional(),
  sharedWorkspaceOwners: z.array(z.object({
    workspaceId: z.string().uuid(),
    newOwnerUserId: z.string().uuid(),
  })).max(500).default([]),
});

const reactivateUserSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const inviteUsersSchema = z.object({
  emails: z.array(z.string().min(1).max(320)).min(1).max(200),
  teamIds: z.array(z.string().uuid()).max(50).default([]),
  leadTeamIds: z.array(z.string().uuid()).max(50).default([]),
  isAdmin: z.boolean().default(false),
  displayName: z.string().max(255).optional(),
});

const listUsersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
  sortBy: z.enum(['displayName', 'email', 'role', 'createdAt']).default('displayName'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  search: z.string().max(200).optional(),
});

export default function usersRoutes(userService: UserService) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const options = listUsersSchema.parse(req.query);
      const result = await userService.listUsersPage(options);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid user list query' });
      }
      console.error('Failed to list users', error);
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  router.get('/directory/list', async (_req, res) => {
    try {
      const users = await userService.listUsers();
      res.json({ users });
    } catch (error) {
      console.error('Failed to list user directory', error);
      res.status(500).json({ error: 'Failed to list user directory' });
    }
  });

  // Declared before the `/:userId` routes so the literal prefix always wins.
  // `DELETE /:userId` matches a single segment, so it could never have swallowed
  // `/invitations/:userId`, but keeping the literal routes together is what stops
  // that from becoming true after the next edit.
  router.get('/invitations', async (_req, res) => {
    try {
      res.json({ invitations: await userService.listPendingInvitations() });
    } catch (error) {
      console.error('Failed to list invitations', error);
      res.status(500).json({ error: 'Failed to list invitations' });
    }
  });

  router.post('/invitations', async (req, res) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      const payload = inviteUsersSchema.parse(req.body || {});
      const results = await userService.inviteUsers(req.userContext.userId, payload);
      res.status(201).json({ results });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid invitation payload' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to register users', error);
      res.status(500).json({ error: 'Failed to register users' });
    }
  });

  router.delete('/invitations/:userId', async (req, res) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      await userService.revokeInvitation(req.params.userId, req.userContext.userId);
      res.status(204).send();
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to revoke invitation', error);
      res.status(500).json({ error: 'Failed to revoke invitation' });
    }
  });

  router.put('/:userId/admin', async (req, res) => {
    try {
      const { isAdmin } = updateAdminSchema.parse(req.body);
      const updated = await userService.setUserAdmin(req.params.userId, isAdmin);
      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid payload' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to update admin role', error);
      res.status(500).json({ error: 'Failed to update admin role' });
    }
  });

  router.get('/:userId/deletion-impact', async (req, res) => {
    try {
      const impact = await userService.getUserDeletionImpact(req.params.userId);
      if (!impact) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(impact);
    } catch (error) {
      console.error('Failed to load user deletion impact', error);
      res.status(500).json({ error: 'Failed to load user deletion impact' });
    }
  });

  router.get('/:userId/deactivation-impact', async (req, res) => {
    try {
      const impact = await userService.getUserDeactivationImpact(req.params.userId);
      if (!impact) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(impact);
    } catch (error) {
      console.error('Failed to load user deactivation impact', error);
      res.status(500).json({ error: 'Failed to load user deactivation impact' });
    }
  });

  router.post('/:userId/deactivate', async (req, res) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      const payload = deactivateUserSchema.parse(req.body || {});
      const result = await userService.deactivateUser(
        req.params.userId,
        req.userContext.userId,
        payload,
      );
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid deactivation payload' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to deactivate user', error);
      res.status(500).json({ error: 'Failed to deactivate user' });
    }
  });

  router.post('/:userId/reactivate', async (req, res) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      const payload = reactivateUserSchema.parse(req.body || {});
      const result = await userService.reactivateUser(
        req.params.userId,
        req.userContext.userId,
        payload,
      );
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid reactivation payload' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to reactivate user', error);
      res.status(500).json({ error: 'Failed to reactivate user' });
    }
  });

  router.delete('/:userId', async (req, res) => {
    try {
      if (!req.userContext) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      if (req.userContext.userId === req.params.userId) {
        return res.status(400).json({ error: 'You cannot delete your own account from the admin portal' });
      }

      const user = await userService.getUserById(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // No artifact cleanup here any more. Deleting a user no longer implies
      // destroying their workspaces: those were archived or handed over at
      // deactivation, and anything still on the row is retained deliberately so
      // it can be restored. `scripts/hard-purge-workspace.ts` is the only path
      // that removes the bytes, and it is run on purpose.
      await userService.deleteUser(user.id, req.userContext.userId);

      res.status(204).send();
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to delete user', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  router.get('/groups/list', async (_req, res) => {
    try {
      const groups = await userService.listGroups();
      res.json({ groups });
    } catch (error) {
      console.error('Failed to list groups', error);
      res.status(500).json({ error: 'Failed to list teams' });
    }
  });

  router.post('/groups', async (req, res) => {
    try {
      const { name } = createGroupSchema.parse(req.body);
      const group = await userService.createGroup(name);
      res.status(201).json({ group });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid payload' });
      }
      console.error('Failed to create group', error);
      res.status(500).json({ error: 'Failed to create team' });
    }
  });

  router.delete('/groups/:groupId', async (req, res) => {
    try {
      const removed = await userService.deleteGroup(req.params.groupId);
      if (!removed) {
        return res.status(404).json({ error: 'Team not found' });
      }
      res.status(204).send();
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to delete group', error);
      res.status(500).json({ error: 'Failed to delete team' });
    }
  });

  router.get('/groups/:groupId/access', async (req, res) => {
    try {
      const access = await userService.getGroupPromptAccess(req.params.groupId);
      if (!access) {
        return res.status(404).json({ error: 'Team not found' });
      }
      res.json(access);
    } catch (error) {
      console.error('Failed to load group access', error);
      res.status(500).json({ error: 'Failed to load team access' });
    }
  });

  router.put('/groups/:groupId/access', async (req, res) => {
    try {
      const payload = groupPromptAccessSchema.parse(req.body);
      const unknownMcpServerIds = findUnknownRuntimeMcpServerIds(
        payload.mcpServerIds,
        await loadRuntimeMcpServers(),
      );
      if (unknownMcpServerIds.length) {
        throw new HttpError(400, `Unknown or disabled MCP servers cannot be assigned: ${unknownMcpServerIds.join(', ')}`);
      }
      const access = await userService.replaceGroupPromptAccess(
        req.params.groupId,
        payload,
        req.userContext?.userId,
      );
      if (!access) {
        return res.status(404).json({ error: 'Team not found' });
      }
      res.json(access);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid payload' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to update group access', error);
      res.status(500).json({ error: 'Failed to update team access' });
    }
  });

  router.get('/groups/:groupId/members', async (req, res) => {
    try {
      const members = await userService.listGroupMembers(req.params.groupId);
      res.json({ members });
    } catch (error) {
      console.error('Failed to list group members', error);
      res.status(500).json({ error: 'Failed to list team members' });
    }
  });

  router.post('/groups/:groupId/members', async (req, res) => {
    try {
      const { userId } = groupMemberSchema.parse(req.body);
      await userService.addGroupMember(req.params.groupId, userId);
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid payload' });
      }
      console.error('Failed to add group member', error);
      res.status(500).json({ error: 'Failed to add team member' });
    }
  });

  router.delete('/groups/:groupId/members/:userId', async (req, res) => {
    try {
      await userService.removeGroupMember(req.params.groupId, req.params.userId);
      res.status(204).send();
    } catch (error) {
      console.error('Failed to remove group member', error);
      res.status(500).json({ error: 'Failed to remove team member' });
    }
  });

  return router;
}
