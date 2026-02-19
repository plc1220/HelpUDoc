import { Router } from 'express';
import { z } from 'zod';
import { UserService } from '../services/userService';

const updateAdminSchema = z.object({
  isAdmin: z.boolean(),
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(128),
});

const groupMemberSchema = z.object({
  userId: z.string().uuid(),
});

export default function usersRoutes(userService: UserService) {
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
