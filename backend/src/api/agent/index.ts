import { Router } from 'express';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import { GoogleOAuthService } from '../../services/googleOAuthService';
import { UserService } from '../../services/userService';
import { ConversationService } from '../../services/conversationService';
import { Paper2SlidesService } from '../../services/paper2SlidesService';
import { Paper2SlidesJobService } from '../../services/paper2SlidesJobService';
import { registerRunRoutes } from './runs';
import { registerSlashRoutes } from './slash';
import { registerPaper2SlidesRoutes } from './paper2slides';
import { registerPresentationRoutes } from './presentation';

export default function(
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
  conversationService: ConversationService,
) {
  const router = Router();
  const paper2SlidesService = new Paper2SlidesService(fileService);
  const paper2SlidesJobService = new Paper2SlidesJobService(fileService, workspaceService, paper2SlidesService);

  registerSlashRoutes(router, userService);
  registerPaper2SlidesRoutes(router, paper2SlidesService, paper2SlidesJobService);
  registerRunRoutes(router, workspaceService, fileService, googleOAuthService, userService, conversationService);
  registerPresentationRoutes(router, workspaceService, fileService, paper2SlidesService);

  return router;
}
