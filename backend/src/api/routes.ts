import { Router } from 'express';
import agentRoutes from './agent';
import authRoutes from './auth';
import workspaceRoutes from './workspaces';
import workspaceCollaborationRoutes from './workspaceCollaboration';
import fileRoutes from './files';
import conversationRoutes from './conversations';
import scheduleRoutes from './schedules';
import settingsRoutes from './settings';
import knowledgeRoutes from './knowledge';
import knowledgeCatalogRoutes from './knowledgeCatalog';
import knowledgeBaseRoutes from './knowledgeBases';
import usersRoutes from './users';
import adminWorkspaceRoutes from './adminWorkspaces';
import settingsReflectionRoutes from './settingsReflections';
import governanceRoutes from './governance';
import meMemoryRoutes from './meMemory';
import mePreferencesRoutes from './mePreferences';
import activityRoutes from './activity';
import { requireActivityAudience } from '../middleware/activityAudience';
import { requireSystemAdmin } from '../middleware/adminOnly';
import { DatabaseService } from '../services/databaseService';
import { WorkspaceService } from '../services/workspaceService';
import { WorkspacePublicationService } from '../services/workspacePublicationService';
import { WorkspaceCollaborationService } from '../services/workspaceCollaborationService';
import { WorkspaceTeamChatAgentService } from '../services/workspaceTeamChatAgentService';
import { FileService } from '../services/fileService';
import { FileStatusService } from '../services/fileStatusService';
import { FilePublicationService } from '../services/filePublicationService';
import { ConversationService } from '../services/conversationService';
import { UserService } from '../services/userService';
import { KnowledgeService } from '../services/knowledgeService';
import { KnowledgeBaseService } from '../services/knowledgeBaseService';
import { DailyReflectionService } from '../services/dailyReflectionService';
import { UserMemoryService } from '../services/userMemoryService';
import { UserOAuthTokenService } from '../services/userOAuthTokenService';
import { GoogleOAuthService } from '../services/googleOAuthService';
import { ScheduleService } from '../services/scheduleService';
import { configureAgentRunServices } from '../services/agentRunService';
import { SkillGovernanceService } from '../services/governance/skillGovernanceService';
import { registerSkillBuilderRoutes } from './settings/skillBuilder';

export default function(
  dbService: DatabaseService,
  userService: UserService,
  skillGovernanceService: SkillGovernanceService,
) {
  const router = Router();
  const workspaceService = new WorkspaceService(dbService);
  const workspacePublicationService = new WorkspacePublicationService(dbService, workspaceService);
  const workspaceCollaborationService = new WorkspaceCollaborationService(
    dbService,
    workspaceService,
    workspacePublicationService,
  );
  const fileService = new FileService(dbService, workspaceService);
  const filePublicationService = new FilePublicationService(dbService, fileService, workspaceService);
  const fileStatusService = new FileStatusService(dbService, workspaceService, filePublicationService, fileService);
  const conversationService = new ConversationService(dbService, workspaceService);
  configureAgentRunServices({ conversationService, fileService });
  const knowledgeService = new KnowledgeService(dbService, workspaceService, fileService);
  const knowledgeBaseService = new KnowledgeBaseService(dbService, knowledgeService);
  const userOAuthTokenService = new UserOAuthTokenService(dbService);
  const googleOAuthService = new GoogleOAuthService(userOAuthTokenService);
  const workspaceTeamChatAgentService = new WorkspaceTeamChatAgentService(
    workspaceService,
    userService,
  );
  const dailyReflectionService = new DailyReflectionService(dbService);
  const userMemoryService = new UserMemoryService(dbService);
  const scheduleService = new ScheduleService(
    dbService,
    workspaceService,
    conversationService,
    userService,
    googleOAuthService,
  );
  router.use('/auth', authRoutes(userService, googleOAuthService));
  router.use('/', governanceRoutes(skillGovernanceService));
  registerSkillBuilderRoutes(router, workspaceService);
  router.use('/agent', agentRoutes(
    workspaceService,
    fileService,
    googleOAuthService,
    userService,
    conversationService,
    knowledgeService,
  ));
  router.use('/settings', requireSystemAdmin(userService), settingsRoutes(workspaceService, userService, dbService));
  router.use('/settings/reflections', requireSystemAdmin(userService), settingsReflectionRoutes(dailyReflectionService));
  router.use('/users', requireSystemAdmin(userService), usersRoutes(userService));
  // Read-only workspace oversight. Every route under it is a GET; see the note
  // in `adminWorkspaces.ts` for why the mutation surface is deliberately empty.
  router.use(
    '/admin/workspaces',
    requireSystemAdmin(userService),
    adminWorkspaceRoutes(workspaceService, fileService),
  );
  router.use('/knowledge', requireSystemAdmin(userService), knowledgeRoutes(knowledgeService, { global: true }));
  router.use('/knowledge-catalog', knowledgeCatalogRoutes(knowledgeService));
  // Not admin-gated: team leads manage their own bases; access is enforced in the service.
  router.use('/knowledge-bases', knowledgeBaseRoutes(knowledgeBaseService, knowledgeService));
  router.use('/workspaces', workspaceRoutes(workspaceService, workspacePublicationService, userService));
  router.use(
    '/workspaces/:workspaceId/collaboration',
    workspaceCollaborationRoutes(workspaceCollaborationService, workspaceTeamChatAgentService),
  );
  router.use('/workspaces/:workspaceId/files', fileRoutes(fileService, workspaceService, googleOAuthService, fileStatusService, filePublicationService));
  router.use('/workspaces/:workspaceId/knowledge', knowledgeRoutes(knowledgeService));
  router.use('/workspaces/:workspaceId/schedules', scheduleRoutes(scheduleService));
  router.use('/me', meMemoryRoutes(workspaceService, userMemoryService));
  router.use('/me', mePreferencesRoutes(userService, dbService.getDb()));
  // Deliberately not under '/settings': that router is admin-only, and a team
  // lead has to be able to reach this.
  router.use('/activity', requireActivityAudience(userService, dbService.getDb()), activityRoutes(dbService.getDb()));
  router.use('/', conversationRoutes(conversationService));

  scheduleService.startScheduler();

  return router;
}
