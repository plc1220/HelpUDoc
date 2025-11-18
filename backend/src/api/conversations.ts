import { Router } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/databaseService';
import { ConversationService } from '../services/conversationService';

export default function conversationRoutes(dbService: DatabaseService) {
  const router = Router();
  const conversationService = new ConversationService(dbService);

  router.get('/workspaces/:workspaceId/conversations', async (req, res) => {
    const { workspaceId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    if (Number.isNaN(limit) || limit <= 0) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    try {
      const conversations = await conversationService.listRecentConversations(workspaceId, limit);
      res.json(conversations);
    } catch (error) {
      console.error('Failed to list conversations', error);
      res.status(500).json({ error: 'Failed to list conversations' });
    }
  });

  const createConversationSchema = z.object({
    persona: z.string().min(1),
  });

  router.post('/workspaces/:workspaceId/conversations', async (req, res) => {
    try {
      const { persona } = createConversationSchema.parse(req.body);
      const conversation = await conversationService.createConversation(req.params.workspaceId, persona);
      res.status(201).json(conversation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      console.error('Failed to create conversation', error);
      res.status(500).json({ error: 'Failed to create conversation' });
    }
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    try {
      const conversation = await conversationService.getConversationWithMessages(req.params.conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json(conversation);
    } catch (error) {
      console.error('Failed to fetch conversation', error);
      res.status(500).json({ error: 'Failed to fetch conversation' });
    }
  });

  const addMessageSchema = z.object({
    sender: z.enum(['user', 'agent']),
    text: z.string().min(1),
  });

  router.post('/conversations/:conversationId/messages', async (req, res) => {
    try {
      const payload = addMessageSchema.parse(req.body);
      const message = await conversationService.appendMessage(req.params.conversationId, payload.sender, payload.text);
      res.status(201).json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if ((error as Error).message === 'Conversation not found') {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      console.error('Failed to append message', error);
      res.status(500).json({ error: 'Failed to append message' });
    }
  });

  router.delete('/conversations/:conversationId', async (req, res) => {
    try {
      const deleted = await conversationService.deleteConversation(req.params.conversationId);
      if (!deleted) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.status(204).send();
    } catch (error) {
      console.error('Failed to delete conversation', error);
      res.status(500).json({ error: 'Failed to delete conversation' });
    }
  });

  return router;
}
