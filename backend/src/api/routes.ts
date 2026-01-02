import { Router } from 'express';
import agentRoutes from './agent';
import workspaceRoutes from './workspaces';
import fileRoutes from './files';
import conversationRoutes from './conversations';
import settingsRoutes from './settings';
import knowledgeRoutes from './knowledge';
import { DatabaseService } from '../services/databaseService';
import { WorkspaceService } from '../services/workspaceService';
import { FileService } from '../services/fileService';
import { ConversationService } from '../services/conversationService';
import { UserService } from '../services/userService';
import { KnowledgeService } from '../services/knowledgeService';
import { redisClient } from '../services/redisService';
import { RagQueueService } from '../services/ragQueueService';

export default function(dbService: DatabaseService, userService: UserService) {
  const router = Router();
  const workspaceService = new WorkspaceService(dbService);
  const ragQueueService = new RagQueueService(redisClient);
  const fileService = new FileService(dbService, workspaceService, ragQueueService);
  const conversationService = new ConversationService(dbService, workspaceService);
  const knowledgeService = new KnowledgeService(dbService, workspaceService);

  router.use('/agent', agentRoutes(workspaceService, fileService));
  router.use('/settings', settingsRoutes());
  router.use('/workspaces', workspaceRoutes(workspaceService, userService));
  router.use('/workspaces/:workspaceId/files', fileRoutes(fileService));
  router.use('/workspaces/:workspaceId/knowledge', knowledgeRoutes(knowledgeService));
  router.use('/', conversationRoutes(conversationService));

  return router;
}
