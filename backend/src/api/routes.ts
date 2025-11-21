import { Router } from 'express';
import agentRoutes from './agent';
import workspaceRoutes from './workspaces';
import fileRoutes from './files';
import conversationRoutes from './conversations';
import settingsRoutes from './settings';
import { DatabaseService } from '../services/databaseService';
import { WorkspaceService } from '../services/workspaceService';
import { FileService } from '../services/fileService';
import { ConversationService } from '../services/conversationService';
import { UserService } from '../services/userService';

export default function(dbService: DatabaseService, userService: UserService) {
  const router = Router();
  const workspaceService = new WorkspaceService(dbService);
  const fileService = new FileService(dbService, workspaceService);
  const conversationService = new ConversationService(dbService, workspaceService);

  router.use('/agent', agentRoutes(workspaceService));
  router.use('/settings', settingsRoutes());
  router.use('/workspaces', workspaceRoutes(workspaceService, userService));
  router.use('/workspaces/:workspaceId/files', fileRoutes(fileService));
  router.use('/', conversationRoutes(conversationService));

  return router;
}
