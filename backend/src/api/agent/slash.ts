import { Router, type Request } from 'express';
import { promises as fs } from 'fs';
import type { UserService } from '../../services/userService';
import { HttpError } from '../../errors';
import { skillsRoot } from '../../services/skills/constants';
import { collectSkillIds } from '../../services/skills/registry';
import { getSkillMetadata } from '../../services/skills/metadata';
import { loadRuntimeMcpServers } from './policy';

type SlashSkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
};

const requireUserContext = (req: Request) => {
  if (!req.userContext) {
    throw new HttpError(401, 'Missing user context');
  }
  return req.userContext;
};

export function registerSlashRoutes(
  router: Router,
  userService: UserService,
) {
  router.get('/slash-metadata', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const promptAccess = await userService.getEffectivePromptAccess(user.userId);
      if (!promptAccess) {
        throw new HttpError(401, 'User not found');
      }
      await fs.mkdir(skillsRoot, { recursive: true });
      const skillIds = await collectSkillIds(skillsRoot);
      const skills: SlashSkillMetadata[] = [];
      const allowedSkillIds = new Set(promptAccess.skillIds);
      for (const skillId of skillIds) {
        if (!promptAccess.isAdmin && !allowedSkillIds.has(skillId)) {
          continue;
        }
        try {
          skills.push(await getSkillMetadata(skillId) as SlashSkillMetadata);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to read skill';
          skills.push({
            id: skillId,
            name: skillId,
            valid: false,
            error: message,
          });
        }
      }

      const allowedMcpServerIds = new Set(promptAccess.mcpServerIds);
      const mcpServers = (await loadRuntimeMcpServers())
        .map((server) => ({
          name: typeof server.name === 'string' ? server.name.trim() : '',
          description: undefined as string | undefined,
        }))
        .filter((server) => promptAccess.isAdmin || allowedMcpServerIds.has(server.name))
        .filter((server) => server.name);

      res.json({ skills, mcpServers });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to load slash metadata', error);
      return res.status(500).json({ error: 'Failed to load slash metadata' });
    }
  });
}
