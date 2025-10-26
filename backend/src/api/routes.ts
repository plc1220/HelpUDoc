import { Router } from 'express';
import agentRoutes from './agent';
import workspaceRoutes from './workspaces';
import fileRoutes from './files';
import { DatabaseService } from '../services/databaseService';

export default function(dbService: DatabaseService) {
  const router = Router();

  // Add your routes here
  router.use('/agent', agentRoutes(dbService));
  router.use('/workspaces', workspaceRoutes(dbService));
  router.use('/workspaces/:workspaceId/files', fileRoutes(dbService));

  return router;
}