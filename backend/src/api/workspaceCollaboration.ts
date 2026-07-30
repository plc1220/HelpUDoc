import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors';
import { WorkspaceCollaborationService } from '../services/workspaceCollaborationService';
import type { WorkspaceTeamChatAgentService } from '../services/workspaceTeamChatAgentService';

const objectTypeSchema = z.enum(['annotation', 'sticky_note', 'task', 'change_proposal']);
const statusSchema = z.enum(['open', 'discussing', 'proposed', 'resolved', 'addressed', 'anchor_changed']);

const createObjectSchema = z.object({
  type: objectTypeSchema,
  visibility: z.enum(['private', 'workspace_audience']).default('workspace_audience'),
  title: z.string().trim().max(255).optional(),
  body: z.string().trim().min(1).max(20_000),
  fileId: z.number().int().positive().optional(),
  filePath: z.string().trim().max(2_000).optional(),
  blockId: z.string().trim().max(255).optional(),
  anchorText: z.string().trim().max(4_000).optional(),
  anchorStart: z.number().int().nonnegative().optional(),
  anchorEnd: z.number().int().nonnegative().optional(),
  anchorFingerprint: z.string().trim().max(255).optional(),
  assigneeId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  sourceTeamMessageId: z.string().uuid().optional(),
}).superRefine((payload, ctx) => {
  if (
    payload.anchorStart !== undefined
    && payload.anchorEnd !== undefined
    && payload.anchorEnd < payload.anchorStart
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'anchorEnd must be greater than or equal to anchorStart',
      path: ['anchorEnd'],
    });
  }
});

const updateObjectSchema = z.object({
  status: statusSchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
}).refine((payload) => Object.keys(payload).length > 0, 'Provide at least one update');

const messageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

const teamMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  replyToMessageId: z.string().uuid().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
});

export default function workspaceCollaborationRoutes(
  service: WorkspaceCollaborationService,
  teamChatAgentService: WorkspaceTeamChatAgentService,
) {
  const router = Router({ mergeParams: true });

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const requireWorkspaceId = (req: Request): string => {
    const workspaceId = (req.params as Record<string, string | undefined>).workspaceId;
    if (!workspaceId) {
      throw new HttpError(400, 'Missing workspace id');
    }
    return workspaceId;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  router.get('/team-chat/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { limit } = z.object({
        limit: z.coerce.number().int().positive().max(500).default(200),
      }).parse(req.query);
      const messages = await service.listTeamMessages(
        requireWorkspaceId(req),
        user.userId,
        limit,
      );
      res.json({ messages });
    } catch (error) {
      handleError(res, error, 'Failed to load Team Chat');
    }
  });

  router.post('/team-chat/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = teamMessageSchema.parse(req.body);
      const message = await service.createTeamMessage(
        requireWorkspaceId(req),
        user.userId,
        input,
      );
      res.status(201).json(message);
    } catch (error) {
      handleError(res, error, 'Failed to post Team Chat message');
    }
  });

  router.post('/team-chat/messages/:messageId/lumo', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = requireWorkspaceId(req);
      const sourceMessage = await service.getLumoRequestMessage(
        workspaceId,
        req.params.messageId,
        user.userId,
      );
      const existing = await service.findLumoReply(workspaceId, sourceMessage.id, user.userId);
      if (existing) {
        return res.json(existing);
      }
      const history = await service.listTeamAgentHistory(
        workspaceId,
        user.userId,
        sourceMessage.id,
      );
      const body = await teamChatAgentService.respond(
        workspaceId,
        user.userId,
        sourceMessage,
        history,
      );
      const reply = await service.appendLumoReply(
        workspaceId,
        sourceMessage,
        user.userId,
        body,
      );
      res.status(201).json(reply);
    } catch (error) {
      handleError(res, error, 'Failed to invoke Lumo in Team Chat');
    }
  });

  router.get('/objects', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const filters = z.object({
        status: statusSchema.optional(),
        type: objectTypeSchema.optional(),
        filePath: z.string().trim().max(2_000).optional(),
      }).parse(req.query);
      const objects = await service.listObjects(requireWorkspaceId(req), user.userId, filters);
      res.json({ objects });
    } catch (error) {
      handleError(res, error, 'Failed to load workspace collaboration');
    }
  });

  router.post('/objects', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = createObjectSchema.parse(req.body);
      const object = await service.createObject(requireWorkspaceId(req), user.userId, input);
      res.status(201).json(object);
    } catch (error) {
      handleError(res, error, 'Failed to create collaboration item');
    }
  });

  router.get('/objects/:objectId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const object = await service.getObject(
        requireWorkspaceId(req),
        req.params.objectId,
        user.userId,
      );
      res.json(object);
    } catch (error) {
      handleError(res, error, 'Failed to load collaboration item');
    }
  });

  router.patch('/objects/:objectId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = updateObjectSchema.parse(req.body);
      const object = await service.updateObject(
        requireWorkspaceId(req),
        req.params.objectId,
        user.userId,
        input,
      );
      res.json(object);
    } catch (error) {
      handleError(res, error, 'Failed to update collaboration item');
    }
  });

  router.post('/objects/:objectId/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = messageSchema.parse(req.body);
      const message = await service.appendMessage(
        requireWorkspaceId(req),
        req.params.objectId,
        user.userId,
        input.body,
      );
      res.status(201).json(message);
    } catch (error) {
      handleError(res, error, 'Failed to reply to collaboration item');
    }
  });

  router.post('/objects/:objectId/proposal', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const object = await service.convertToProposal(
        requireWorkspaceId(req),
        req.params.objectId,
        user.userId,
      );
      res.json(object);
    } catch (error) {
      handleError(res, error, 'Failed to create change proposal');
    }
  });

  return router;
}
