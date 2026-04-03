import { Router } from 'express';
import agentRoutes from './agent';
import authRoutes from './auth';
import workspaceRoutes from './workspaces';
import fileRoutes from './files';
import conversationRoutes from './conversations';
import settingsRoutes from './settings';
import knowledgeRoutes from './knowledge';
import usersRoutes from './users';
import settingsReflectionRoutes from './settingsReflections';
import meMemoryRoutes from './meMemory';
import { requireSystemAdmin } from '../middleware/adminOnly';
import { DatabaseService } from '../services/databaseService';
import { WorkspaceService } from '../services/workspaceService';
import { FileService } from '../services/fileService';
import { ConversationService } from '../services/conversationService';
import { UserService } from '../services/userService';
import { KnowledgeService } from '../services/knowledgeService';
import { DailyReflectionService } from '../services/dailyReflectionService';
import { UserMemoryService } from '../services/userMemoryService';
import { redisClient } from '../services/redisService';
import { RagQueueService } from '../services/ragQueueService';
import { UserOAuthTokenService } from '../services/userOAuthTokenService';
import { GoogleOAuthService } from '../services/googleOAuthService';

export default function(dbService: DatabaseService, userService: UserService) {
  const router = Router();
  const ragQueueService = new RagQueueService(redisClient);
  const workspaceService = new WorkspaceService(dbService, ragQueueService);
  const fileService = new FileService(dbService, workspaceService, ragQueueService);
  const conversationService = new ConversationService(dbService, workspaceService);
  const knowledgeService = new KnowledgeService(dbService, workspaceService);
  const userOAuthTokenService = new UserOAuthTokenService(dbService);
  const googleOAuthService = new GoogleOAuthService(userOAuthTokenService);
  const dailyReflectionService = new DailyReflectionService(dbService);
  const userMemoryService = new UserMemoryService(dbService);

  router.use('/auth', authRoutes(userService, googleOAuthService));
  router.use('/agent', agentRoutes(workspaceService, fileService, googleOAuthService, userService));
  router.use('/settings', requireSystemAdmin(userService), settingsRoutes(workspaceService));
  router.use('/settings/reflections', requireSystemAdmin(userService), settingsReflectionRoutes(dailyReflectionService));
  router.use('/users', requireSystemAdmin(userService), usersRoutes(userService, workspaceService));
  router.use('/workspaces', workspaceRoutes(workspaceService, userService));
  router.use('/workspaces/:workspaceId/files', fileRoutes(fileService));
  router.use('/workspaces/:workspaceId/knowledge', knowledgeRoutes(knowledgeService));
  router.use('/me', meMemoryRoutes(workspaceService, userMemoryService));
  router.use('/', conversationRoutes(conversationService));

  return router;
}
