import { Router } from 'express';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import { GoogleOAuthService } from '../../services/googleOAuthService';
import { UserService } from '../../services/userService';
import { ConversationService } from '../../services/conversationService';
import { registerRunRoutes } from './runs';
import { registerSlashRoutes } from './slash';

export default function(
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
  conversationService: ConversationService,
) {
  const router = Router();

  registerSlashRoutes(router, userService);
  registerRunRoutes(router, workspaceService, fileService, googleOAuthService, userService, conversationService);

  return router;
}
