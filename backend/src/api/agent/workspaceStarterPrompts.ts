import type { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../errors';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import type { ConversationService } from '../../services/conversationService';
import { signAgentContextToken } from '../../services/agentToken';
import { starterPromptsSchema, suggestWorkspaceStarterPrompts } from '../../services/agentService';

const requestSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export function registerWorkspaceStarterPromptsRoute(
  router: Router,
  workspaces: Pick<WorkspaceService, 'getWorkspaceForUser'>,
  files: Pick<FileService, 'getFiles'>,
  conversations: Pick<ConversationService, 'listRecentConversations'>,
  suggest = suggestWorkspaceStarterPrompts,
) {
  const cache = new Map<string, { expires: number; result: z.infer<typeof starterPromptsSchema> }>();
  router.post('/workspace-starter-prompts', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.userContext) return res.status(401).json({ error: 'Missing user context' });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Select a workspace for starter prompts' });
    const { workspaceId } = parsed.data, { userId } = req.userContext;
    try {
      // Access is checked before inspecting metadata or serving a cached result.
      const { workspace, membership } = await workspaces.getWorkspaceForUser(workspaceId, userId);
      const [visibleFiles, recent] = await Promise.all([
        files.getFiles(workspaceId, userId),
        conversations.listRecentConversations(userId, workspaceId, 5),
      ]);
      const context = {
        name: workspace.name.slice(0, 255),
        readOnly: !['owner', 'editor', 'contributor'].includes(membership.role),
        files: visibleFiles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 24).map(file => ({
          name: String(file.name).slice(0, 300), mimeType: String(file.mimeType || '').slice(0, 100),
        })),
        recentTopics: recent.map(item => item.title?.trim()).filter(Boolean).slice(0, 5).map(title => title.slice(0, 200)),
      };
      const key = JSON.stringify([userId, workspaceId, workspace.contentRevision, context]);
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return res.json(cached.result);
      const token = signAgentContextToken({
        sub: userId, userId, workspaceId, isAdmin: false, skillAllowIds: [], mcpServerAllowIds: [],
        exp: Math.floor(Date.now() / 1000) + 30,
      });
      if (!token) return res.status(503).json({ error: 'Workspace suggestions are unavailable' });
      const result = starterPromptsSchema.parse(await suggest(context, token));
      if (cache.size >= 100) cache.clear();
      cache.set(key, { expires: Date.now() + 5 * 60 * 1000, result });
      return res.json(result);
    } catch (error) {
      if (error instanceof HttpError) return res.status(error.statusCode).json({ error: error.message });
      return res.status(503).json({ error: 'Workspace suggestions are temporarily unavailable' });
    }
  });
}
