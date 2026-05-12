import { Router } from 'express';
import type { WorkspaceService } from '../../services/workspaceService';
import type { DatabaseService } from '../../services/databaseService';
import type { UserService } from '../../services/userService';
import { buildWorkspaceOverview } from '../../services/workspaceOverviewService';
import { fetchLangfuseAggregates } from '../../services/langfuseClient';
import { skillsRoot } from '../../services/skills/constants';
import { registerAgentConfigRoutes } from './agentConfig';
import { registerSkillsRoutes } from './skills';
import { registerSkillBuilderRoutes } from './skillBuilder';
import { registerGithubImportRoutes } from './githubImport';

export default function settingsRoutes(
  workspaceService: WorkspaceService,
  userService: UserService,
  databaseService: DatabaseService,
) {
  const router = Router();

  router.get('/workspace-overview', async (_req, res) => {
    try {
      const body = await buildWorkspaceOverview({
        db: databaseService.getDb(),
        userService,
        skillsRoot,
        nodeEnv: process.env.NODE_ENV,
        fetchLangfuse: fetchLangfuseAggregates,
        now: () => Date.now(),
      });
      res.json(body);
    } catch (error) {
      console.error('Failed to load workspace overview', error);
      res.status(500).json({ error: 'Failed to load workspace overview' });
    }
  });

  registerAgentConfigRoutes(router);
  registerSkillsRoutes(router);
  registerSkillBuilderRoutes(router, workspaceService);
  registerGithubImportRoutes(router);

  return router;
}
