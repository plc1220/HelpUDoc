import { Router, type Request } from 'express';
import { promises as fs } from 'fs';
import type { UserService, WorkspaceSkillDraftRuntimePin } from '../../services/userService';
import type { WorkspaceService } from '../../services/workspaceService';
import { HttpError } from '../../errors';
import { privateSkillRuntimeEnabled, skillsRoot } from '../../services/skills/constants';
import { collectSkillIds } from '../../services/skills/registry';
import { getSkillMetadata } from '../../services/skills/metadata';
import { buildPluginBySkillMap, filterPluginsForAccess, listPlugins } from '../../services/plugins/registry';
import { loadRuntimeMcpServers, resolveRuntimeSkillAccess } from './policy';

type SlashSkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
  pluginId?: string;
  pluginName?: string;
};

const draftSlashMetadata = (pin: WorkspaceSkillDraftRuntimePin): SlashSkillMetadata => ({
  id: pin.skillKey,
  name: pin.displayName,
  description: pin.description || undefined,
  valid: true,
  warning: 'Your private draft. It runs only in this workspace and has not been reviewed.',
});

const requireUserContext = (req: Request) => {
  if (!req.userContext) {
    throw new HttpError(401, 'Missing user context');
  }
  return req.userContext;
};

export function registerSlashRoutes(
  router: Router,
  workspaceService: WorkspaceService,
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
      const [skillIds, plugins] = await Promise.all([
        collectSkillIds(skillsRoot),
        listPlugins(),
      ]);
      const pluginBySkill = buildPluginBySkillMap(plugins);
      const skills: SlashSkillMetadata[] = [];
      let runtimeSkillIds = promptAccess.skillIds;
      let draftPins: WorkspaceSkillDraftRuntimePin[] = [];
      const workspaceId = typeof req.query.workspaceId === 'string'
        ? req.query.workspaceId.trim()
        : '';
      if (workspaceId) {
        const [workspacePolicy, pins] = await Promise.all([
          workspaceService.getMcpServerPolicy(workspaceId, user.userId),
          userService.getWorkspaceSkillRuntimePins(workspaceId),
        ]);
        runtimeSkillIds = resolveRuntimeSkillAccess(
          promptAccess.skillIds,
          pins,
          workspacePolicy.workspaceMode,
        ).skillAllowIds;
        // Mirrors the merge in `buildAgentAuthToken`, so the picker offers the
        // same skills the runtime will accept.
        if (workspacePolicy.workspaceMode === 'private' && privateSkillRuntimeEnabled()) {
          draftPins = await userService.getWorkspaceSkillDraftRuntimePins(workspaceId, user.userId);
          runtimeSkillIds = Array.from(new Set([
            ...runtimeSkillIds,
            ...draftPins.map((pin) => pin.skillKey),
          ]));
        }
      }
      const draftPinByKey = new Map(draftPins.map((pin) => [pin.skillKey, pin]));
      const allowedSkillIds = new Set(runtimeSkillIds);
      for (const skillId of skillIds) {
        if (!allowedSkillIds.has(skillId)) {
          continue;
        }
        // An improvement draft replaces the approved skill of the same key for
        // as long as it is pinned here, so describe the draft, not the default.
        const shadowingDraft = draftPinByKey.get(skillId);
        if (shadowingDraft) {
          skills.push(draftSlashMetadata(shadowingDraft));
          draftPinByKey.delete(skillId);
          continue;
        }
        try {
          skills.push(await getSkillMetadata(skillId, pluginBySkill) as SlashSkillMetadata);
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
      // A new-skill draft has no folder under `skills/`, so it never appeared in
      // the loop above.
      for (const pin of draftPinByKey.values()) {
        skills.push(draftSlashMetadata(pin));
      }

      const allowedMcpServerIds = new Set(promptAccess.mcpServerIds);
      const mcpServers = (await loadRuntimeMcpServers())
        .map((server) => ({
          name: typeof server.name === 'string' ? server.name.trim() : '',
          description: undefined as string | undefined,
        }))
          .filter((server) => allowedMcpServerIds.has(server.name))
          .filter((server) => server.name);

      res.json({
        skills,
        mcpServers,
        plugins: filterPluginsForAccess(plugins, {
          isAdmin: false,
          skillIds: runtimeSkillIds,
          mcpServerIds: promptAccess.mcpServerIds,
        }),
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to load slash metadata', error);
      return res.status(500).json({ error: 'Failed to load slash metadata' });
    }
  });
}
