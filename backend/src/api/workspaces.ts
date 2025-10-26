import { Router } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspaceService';
import { DatabaseService } from '../services/databaseService';

export default function(dbService: DatabaseService) {
  const router = Router();
  const workspaceService = new WorkspaceService(dbService);

  const createWorkspaceSchema = z.object({
    name: z.string().min(1).max(255),
  });

  router.get('/', async (req, res) => {
    const workspaces = await workspaceService.getWorkspaces();
    res.json(workspaces);
  });

  router.post('/', async (req, res) => {
    try {
      const { name } = createWorkspaceSchema.parse(req.body);
      const newWorkspace = await workspaceService.createWorkspace(name);
      res.status(201).json(newWorkspace);
    } catch (error) {
      res.status(400).json({ error: 'Invalid input' });
    }
  });

  router.get('/:workspaceId', (req, res) => {
    // TODO: Implement get workspace logic
    res.json({ id: req.params.workspaceId, name: 'Test Workspace', files: [] });
  });

  router.delete('/:workspaceId', async (req, res) => {
    await workspaceService.deleteWorkspace(req.params.workspaceId);
    res.status(204).send();
  });

  return router;
}