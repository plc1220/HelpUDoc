import type { Router } from 'express';
import { z } from 'zod';
import { signAgentContextToken } from '../../services/agentToken';
import { suggestFollowUpPrompt } from '../../services/agentService';

const requestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(8000),
  }).strict()).min(2).max(6),
}).strict().refine(({ messages }) =>
  messages[messages.length - 1]?.role === 'assistant'
  && messages.some(message => message.role === 'user')
  && messages.reduce((size, message) => size + message.content.length, 0) <= 24000,
);

export function registerPromptSuggestionRoute(router: Router, suggest = suggestFollowUpPrompt) {
  router.post('/prompt-suggestion', async (req, res) => {
    if (!req.userContext) return res.status(401).json({ error: 'Missing user context' });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A completed conversation turn is required' });
    const userId = req.userContext.userId;
    const token = signAgentContextToken({
      sub: userId, userId, isAdmin: false, skillAllowIds: [], mcpServerAllowIds: [],
      exp: Math.floor(Date.now() / 1000) + 30,
    });
    if (!token) return res.status(503).json({ error: 'Prompt suggestions are unavailable' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await suggest(parsed.data.messages, token));
    } catch {
      // Suggestions are optional; never expose provider details or break chat.
      return res.status(503).json({ error: 'Prompt suggestions are temporarily unavailable' });
    }
  });
}
