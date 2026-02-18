import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ConversationService } from '../services/conversationService';
import { HttpError } from '../errors';

export default function conversationRoutes(conversationService: ConversationService) {
  const router = Router();

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  router.get('/workspaces/:workspaceId/conversations', async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const limit = req.query.limit ? Number(req.query.limit) : 5;
      if (Number.isNaN(limit) || limit <= 0) {
        return res.status(400).json({ error: 'Invalid limit' });
      }
      const user = requireUserContext(req);
      const conversations = await conversationService.listRecentConversations(user.userId, workspaceId, limit);
      res.json(conversations);
    } catch (error) {
      handleError(res, error, 'Failed to list conversations');
    }
  });

  const createConversationSchema = z.object({
    persona: z.string().min(1),
  });

  router.post('/workspaces/:workspaceId/conversations', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona } = createConversationSchema.parse(req.body);
      const conversation = await conversationService.createConversation(user.userId, req.params.workspaceId, persona);
      res.status(201).json(conversation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to create conversation');
    }
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const conversation = await conversationService.getConversationWithMessages(user.userId, req.params.conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json(conversation);
    } catch (error) {
      handleError(res, error, 'Failed to fetch conversation');
    }
  });

  const addMessageSchema = z.object({
    sender: z.enum(['user', 'agent']),
    text: z.string(),
    turnId: z.string().min(1).optional(),
    replaceExisting: z.boolean().optional(),
    metadata: z.object({
      thinkingText: z.string().optional(),
      toolEvents: z.array(z.object({
        id: z.string().optional(),
        name: z.string(),
        status: z.enum(['running', 'completed', 'error']).optional(),
        summary: z.string().optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
        outputFiles: z.array(z.object({
          path: z.string(),
          mimeType: z.string().nullable().optional(),
          size: z.number().int().nonnegative().optional(),
        }).strict()).optional(),
      }).strict()).optional(),
      runId: z.string().optional(),
      status: z.enum(['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled']).optional(),
      pendingInterrupt: z.object({
        actionRequests: z.array(z.object({
          name: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
        }).passthrough()).optional(),
        reviewConfigs: z.array(z.object({
          action_name: z.string().optional(),
          allowed_decisions: z.array(z.string()).optional(),
        }).passthrough()).optional(),
      }).passthrough().optional(),
      runPolicy: z.object({
        skill: z.string().optional(),
        requiresHitlPlan: z.boolean().optional(),
        requiresArtifacts: z.boolean().optional(),
        requiredArtifactsMode: z.string().optional(),
        prePlanSearchLimit: z.number().int().nonnegative().optional(),
        prePlanSearchUsed: z.number().int().nonnegative().optional(),
      }).passthrough().optional(),
    }).passthrough().partial().optional(),
  }).superRefine((payload, ctx) => {
    if (payload.sender === 'user' && payload.text.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Text is required for user messages',
        path: ['text'],
      });
    }
  });

  router.post('/conversations/:conversationId/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = addMessageSchema.parse(req.body);
      const message = await conversationService.appendMessage(
        user.userId,
        req.params.conversationId,
        payload.sender,
        payload.text,
        {
          turnId: payload.turnId,
          replaceExisting: payload.replaceExisting,
          metadata: payload.metadata,
        }
      );
      res.status(201).json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to append message');
    }
  });

  const truncateMessagesSchema = z.object({
    afterMessageId: z.coerce.number().int().positive(),
  });

  router.delete('/conversations/:conversationId/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { afterMessageId } = truncateMessagesSchema.parse(req.query);
      const deleted = await conversationService.truncateConversationAfterMessage(
        user.userId,
        req.params.conversationId,
        afterMessageId,
      );
      res.status(200).json({ deleted });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to truncate conversation messages');
    }
  });

  router.delete('/conversations/:conversationId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const deleted = await conversationService.deleteConversation(user.userId, req.params.conversationId);
      if (!deleted) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete conversation');
    }
  });

  return router;
}
