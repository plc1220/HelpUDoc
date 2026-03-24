import { Router } from 'express';
import { z } from 'zod';
import { UserService } from '../services/userService';
import { WorkspaceService } from '../services/workspaceService';

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
});

export default function usersRoutes(userService: UserService, workspaceService: WorkspaceService) {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const users = await userService.listUsers();
      res.json({ users });
    } catch (error) {
      console.error('Failed to list users', error);
      res.status(500).json({ error: 'Failed to list users' });
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

      const ownedWorkspaces = await userService.listOwnedWorkspaces(user.id);
      for (const workspace of ownedWorkspaces) {
        await workspaceService.deleteWorkspaceForCleanup(workspace.id);
      }

      await userService.deleteUser(user.id);
      res.status(204).send();
    } catch (error) {
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
      res.status(500).json({ error: 'Failed to list groups' });
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
      res.status(500).json({ error: 'Failed to create group' });
    }
  });

  router.delete('/groups/:groupId', async (req, res) => {
    try {
      const removed = await userService.deleteGroup(req.params.groupId);
      if (!removed) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.status(204).send();
    } catch (error) {
      console.error('Failed to delete group', error);
      res.status(500).json({ error: 'Failed to delete group' });
    }
  });

  router.get('/groups/:groupId/access', async (req, res) => {
    try {
      const access = await userService.getGroupPromptAccess(req.params.groupId);
      if (!access) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.json(access);
    } catch (error) {
      console.error('Failed to load group access', error);
      res.status(500).json({ error: 'Failed to load group access' });
    }
  });

  router.put('/groups/:groupId/access', async (req, res) => {
    try {
      const payload = groupPromptAccessSchema.parse(req.body);
      const access = await userService.replaceGroupPromptAccess(req.params.groupId, payload);
      if (!access) {
        return res.status(404).json({ error: 'Group not found' });
      }
      res.json(access);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || 'Invalid payload' });
      }
      console.error('Failed to update group access', error);
      res.status(500).json({ error: 'Failed to update group access' });
    }
  });

  router.get('/groups/:groupId/members', async (req, res) => {
    try {
      const members = await userService.listGroupMembers(req.params.groupId);
      res.json({ members });
    } catch (error) {
      console.error('Failed to list group members', error);
      res.status(500).json({ error: 'Failed to list group members' });
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
      res.status(500).json({ error: 'Failed to add group member' });
    }
  });

  router.delete('/groups/:groupId/members/:userId', async (req, res) => {
    try {
      await userService.removeGroupMember(req.params.groupId, req.params.userId);
      res.status(204).send();
    } catch (error) {
      console.error('Failed to remove group member', error);
      res.status(500).json({ error: 'Failed to remove group member' });
    }
  });

  return router;
}
