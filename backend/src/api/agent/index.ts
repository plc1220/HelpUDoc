import { Router } from 'express';
import type { CalendarService } from '../../services/calendarService';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import { GoogleOAuthService } from '../../services/googleOAuthService';
import { UserService } from '../../services/userService';
import { ConversationService } from '../../services/conversationService';
import type { KnowledgeService } from '../../services/knowledgeService';
import { registerRunRoutes } from './runs';
import { registerSlashRoutes } from './slash';
import { registerPromptSuggestionRoute } from './promptSuggestion';
import { registerWorkspaceStarterPromptsRoute } from './workspaceStarterPrompts';

export default function(
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
  conversationService: ConversationService,
  knowledgeService: KnowledgeService,
  calendarService?: CalendarService,
) {
  const router = Router();

  registerPromptSuggestionRoute(router);
  registerWorkspaceStarterPromptsRoute(router, workspaceService, fileService, conversationService);

  registerSlashRoutes(router, workspaceService, userService);
  registerRunRoutes(
    router,
    workspaceService,
    fileService,
    googleOAuthService,
    userService,
    conversationService,
    knowledgeService,
    calendarService,
  );

  return router;
}
