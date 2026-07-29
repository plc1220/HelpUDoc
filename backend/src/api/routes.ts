import { Router } from 'express';
import agentRoutes from './agent';
import authRoutes from './auth';
import workspaceRoutes from './workspaces';
import fileRoutes from './files';
import conversationRoutes from './conversations';
import scheduleRoutes from './schedules';
import settingsRoutes from './settings';
import knowledgeRoutes from './knowledge';
import usersRoutes from './users';
import settingsReflectionRoutes from './settingsReflections';
import settingsSkillEvolutionRoutes from './settingsSkillEvolution';
import meMemoryRoutes from './meMemory';
import { requireSystemAdmin } from '../middleware/adminOnly';
import { DatabaseService } from '../services/databaseService';
import { WorkspaceService } from '../services/workspaceService';
import { WorkspacePublicationService } from '../services/workspacePublicationService';
import { FileService } from '../services/fileService';
import { ConversationService } from '../services/conversationService';
import { UserService } from '../services/userService';
import { KnowledgeService } from '../services/knowledgeService';
import { DailyReflectionService } from '../services/dailyReflectionService';
import { UserMemoryService } from '../services/userMemoryService';
import { SkillEvolutionService } from '../services/skillEvolutionService';
import { UserOAuthTokenService } from '../services/userOAuthTokenService';
import { GoogleOAuthService } from '../services/googleOAuthService';
import { ScheduleService } from '../services/scheduleService';
import { configureAgentRunServices } from '../services/agentRunService';

export default function(dbService: DatabaseService, userService: UserService) {
  const router = Router();
  const workspaceService = new WorkspaceService(dbService);
  const workspacePublicationService = new WorkspacePublicationService(dbService, workspaceService);
  const fileService = new FileService(dbService, workspaceService);
  const conversationService = new ConversationService(dbService, workspaceService);
  configureAgentRunServices({ conversationService });
  const knowledgeService = new KnowledgeService(dbService, workspaceService, fileService);
  const userOAuthTokenService = new UserOAuthTokenService(dbService);
  const googleOAuthService = new GoogleOAuthService(userOAuthTokenService);
  const skillEvolutionService = new SkillEvolutionService(dbService);
  const dailyReflectionService = new DailyReflectionService(dbService, skillEvolutionService);
  const userMemoryService = new UserMemoryService(dbService);
  const scheduleService = new ScheduleService(
    dbService,
    workspaceService,
    conversationService,
    userService,
    googleOAuthService,
  );
  router.use('/auth', authRoutes(userService, googleOAuthService));
  router.use('/agent', agentRoutes(workspaceService, fileService, googleOAuthService, userService, conversationService));
  router.use('/settings', requireSystemAdmin(userService), settingsRoutes(workspaceService, userService, dbService));
  router.use('/settings/reflections', requireSystemAdmin(userService), settingsReflectionRoutes(dailyReflectionService));
  router.use('/settings/skill-evolution', requireSystemAdmin(userService), settingsSkillEvolutionRoutes(skillEvolutionService));
  router.use('/users', requireSystemAdmin(userService), usersRoutes(userService, workspaceService));
  router.use('/workspaces', workspaceRoutes(workspaceService, workspacePublicationService, userService));
  router.use('/workspaces/:workspaceId/files', fileRoutes(fileService, workspaceService, googleOAuthService));
  router.use('/workspaces/:workspaceId/knowledge', knowledgeRoutes(knowledgeService));
  router.use('/workspaces/:workspaceId/schedules', scheduleRoutes(scheduleService));
  router.use('/me', meMemoryRoutes(workspaceService, userMemoryService));
  router.use('/', conversationRoutes(conversationService));

  scheduleService.startScheduler();

  return router;
}
