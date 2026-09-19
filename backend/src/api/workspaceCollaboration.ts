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
  anchorText: z.string().max(4_000).optional(),
  anchorStart: z.number().int().nonnegative().optional(),
  anchorEnd: z.number().int().nonnegative().optional(),
  anchorFingerprint: z.string().trim().max(255).optional(),
  assigneeId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  sourceTeamMessageId: z.string().uuid().optional(),
  sourceThreadId: z.string().uuid().optional(),
  anchorVersionId: z.string().uuid().optional(),
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
  sourceThreadId: z.string().uuid().nullable().optional(),
}).refine((payload) => Object.keys(payload).length > 0, 'Provide at least one update');

const messageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), id: z.string().uuid(), label: z.string().max(255) }),
  z.object({ kind: z.literal('agent'), id: z.literal('lumo'), label: z.string().max(255) }),
  z.object({ kind: z.literal('skill'), id: z.string().min(1).max(255), label: z.string().max(255) }),
  z.object({ kind: z.literal('file'), id: z.string().min(1).max(2000), label: z.string().max(2000), version: z.number().int().positive().optional(), publishedVersionId: z.string().uuid().optional() }),
  // F8: explicit, version-pinned annotation reference. Linking alone never
  // includes an annotation; it is included ONLY when explicitly referenced here.
  z.object({ kind: z.literal('annotation'), id: z.string().uuid(), label: z.string().max(2000), anchorVersionId: z.string().uuid().optional() }),
]);

const teamMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  replyToMessageId: z.string().uuid().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  references: z.array(referenceSchema).max(50).refine((refs) => refs.filter((ref) => ref.kind === 'skill').length <= 1, 'Choose one skill per request').optional(),
});

const createThreadSchema = z.object({
  title: z.string().trim().max(255).optional(),
  body: z.string().trim().min(1).max(20_000),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  references: z.array(referenceSchema).max(50).refine((refs) => refs.filter((ref) => ref.kind === 'skill').length <= 1, 'Choose one skill per request').optional(),
  clientMessageId: z.string().trim().min(1).max(128).optional(),
});

const threadMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  replyToMessageId: z.string().uuid().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  references: z.array(referenceSchema).max(50).refine((refs) => refs.filter((ref) => ref.kind === 'skill').length <= 1, 'Choose one skill per request').optional(),
  clientMessageId: z.string().trim().min(1).max(128).optional(),
});

const patchThreadSchema = z.object({
  title: z.string().trim().max(255).optional(),
  status: z.enum(['open', 'resolved']).optional(),
}).refine((payload) => Object.keys(payload).length > 0, 'Provide at least one update');

const submissionSchema = z.object({
  expectedSharedRevision: z.number().int().nonnegative(),
  expectedPrivateRevision: z.number().int().nonnegative(),
  publicExplanation: z.string().trim().max(20_000).optional(),
  selectedOperations: z.array(z.object({
    path: z.string().trim().min(1).max(2_000),
    fromPath: z.string().trim().min(1).max(2_000).optional(),
    fileId: z.number().int().positive().optional(),
    changeKind: z.string().trim().max(32).optional(),
  })).min(1).max(500),
});

const reviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  comment: z.string().trim().max(20_000).optional(),
});

const applySubmissionSchema = z.object({
  submissionId: z.string().uuid(),
  expectedSharedRevision: z.number().int().nonnegative(),
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
      const { limit, includeMessageId } = z.object({
        includeMessageId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(500).default(200),
      }).parse(req.query);
      await teamChatAgentService.refresh(requireWorkspaceId(req), user.userId);
      const messages = await service.listTeamMessages(
        requireWorkspaceId(req),
        user.userId,
        limit,
        includeMessageId,
      );
      res.json({ messages });
    } catch (error) {
      handleError(res, error, 'Failed to load Workspace Chat');
    }
  });

  router.post('/team-chat/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = teamMessageSchema.parse(req.body);
      const references = input.references || [];
      await teamChatAgentService.resolveReferences(requireWorkspaceId(req), user.userId, references);
      input.mentionedUserIds = [...new Set([...(input.mentionedUserIds || []), ...references.filter((ref) => ref.kind === 'person').map((ref) => ref.id)])];
      const message = await service.createTeamMessage(
        requireWorkspaceId(req),
        user.userId,
        input,
      );
      if (message.mentionsLumo) {
        // Persisted queued metadata allows recovery even if dispatch is interrupted.
        void teamChatAgentService.enqueue(requireWorkspaceId(req), user.userId, message.id).catch(async (error) => {
          await service.updateTeamRun(requireWorkspaceId(req), message.id, { ...(error instanceof HttpError && error.statusCode < 500 ? { runStatus: 'failed' } : {}), error: error instanceof Error ? error.message : 'Unable to start Lumo' }).catch((persistError) => console.error('Unable to record team dispatch failure', persistError));
        });
      }
      res.status(201).json(message);
    } catch (error) {
      handleError(res, error, 'Failed to post Workspace Chat message');
    }
  });

  router.post('/team-chat/messages/:messageId/lumo', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = requireWorkspaceId(req);
      await teamChatAgentService.enqueue(workspaceId, user.userId, req.params.messageId);
      res.status(202).json({ status: 'queued' });
    } catch (error) {
      handleError(res, error, 'Failed to invoke Lumo in Workspace Chat');
    }
  });

  router.post('/team-chat/messages/:messageId/interaction', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = z.object({ decision: z.enum(['approve', 'reject']).optional(), message: z.string().max(20000).optional(), actionId: z.string().max(255).optional() }).parse(req.body);
      await teamChatAgentService.respondToInteraction(requireWorkspaceId(req), user.userId, req.params.messageId, input);
      res.json({ status: 'running' });
    } catch (error) { handleError(res, error, 'Failed to respond to Lumo'); }
  });

  // --- Team Chat threads (Release A) -------------------------------------

  // Rollout readiness contract consumed by the frontend to decide whether to show
  // the threaded UI/context or keep the existing flat Team Chat. Authorized:
  // requires current workspace access. Never enables threaded reads while any
  // message is unmapped (spec section 7).
  router.get('/team-chat/readiness', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const readiness = await service.getTeamChatReadiness(requireWorkspaceId(req), user.userId);
      res.json(readiness);
    } catch (error) { handleError(res, error, 'Failed to load Team Chat readiness'); }
  });

  router.get('/team-chat/threads', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const query = z.object({
        status: z.enum(['open', 'resolved', 'all']).default('all'),
        cursor: z.string().max(4_000).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }).parse(req.query);
      await teamChatAgentService.refresh(requireWorkspaceId(req), user.userId);
      const result = await service.listThreads(requireWorkspaceId(req), user.userId, query);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to load threads'); }
  });

  router.post('/team-chat/threads', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = requireWorkspaceId(req);
      const input = createThreadSchema.parse(req.body);
      const references = input.references || [];
      await teamChatAgentService.resolveReferences(workspaceId, user.userId, references as any);
      const mentionedUserIds = [...new Set([...(input.mentionedUserIds || []), ...references.filter((ref) => ref.kind === 'person').map((ref) => ref.id)])];
      const result = await service.createThread(workspaceId, user.userId, { ...input, mentionedUserIds });
      if (result.message.mentionsLumo) {
        void teamChatAgentService.enqueue(workspaceId, user.userId, result.message.id).catch(async (error) => {
          await service.updateTeamRun(workspaceId, result.message.id, { ...(error instanceof HttpError && error.statusCode < 500 ? { runStatus: 'failed' } : {}), error: error instanceof Error ? error.message : 'Unable to start Lumo' }).catch(() => undefined);
        });
      }
      res.status(201).json(result);
    } catch (error) { handleError(res, error, 'Failed to create thread'); }
  });

  router.get('/team-chat/threads/:threadId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const thread = await service.getThread(requireWorkspaceId(req), req.params.threadId, user.userId);
      res.json({ thread });
    } catch (error) { handleError(res, error, 'Failed to load thread'); }
  });

  router.get('/team-chat/threads/:threadId/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const query = z.object({
        beforeSeq: z.coerce.number().int().nonnegative().optional(),
        afterSeq: z.coerce.number().int().nonnegative().optional(),
        aroundMessageId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }).parse(req.query);
      const result = await service.listThreadMessages(requireWorkspaceId(req), req.params.threadId, user.userId, query);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to load thread messages'); }
  });

  router.post('/team-chat/threads/:threadId/messages', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const workspaceId = requireWorkspaceId(req);
      const input = threadMessageSchema.parse(req.body);
      const references = input.references || [];
      await teamChatAgentService.resolveReferences(workspaceId, user.userId, references as any);
      const mentionedUserIds = [...new Set([...(input.mentionedUserIds || []), ...references.filter((ref) => ref.kind === 'person').map((ref) => ref.id)])];
      const message = await service.postThreadMessage(workspaceId, req.params.threadId, user.userId, { ...input, mentionedUserIds });
      if (message.mentionsLumo) {
        void teamChatAgentService.enqueue(workspaceId, user.userId, message.id).catch(async (error) => {
          await service.updateTeamRun(workspaceId, message.id, { ...(error instanceof HttpError && error.statusCode < 500 ? { runStatus: 'failed' } : {}), error: error instanceof Error ? error.message : 'Unable to start Lumo' }).catch(() => undefined);
        });
      }
      res.status(201).json(message);
    } catch (error) { handleError(res, error, 'Failed to post thread message'); }
  });

  router.patch('/team-chat/threads/:threadId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = patchThreadSchema.parse(req.body);
      const thread = await service.patchThread(requireWorkspaceId(req), req.params.threadId, user.userId, input);
      res.json({ thread });
    } catch (error) { handleError(res, error, 'Failed to update thread'); }
  });

  router.put('/team-chat/threads/:threadId/read-state', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = z.object({ lastReadSeq: z.number().int().nonnegative() }).parse(req.body);
      const result = await service.setThreadReadState(requireWorkspaceId(req), req.params.threadId, user.userId, input.lastReadSeq);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to update read state'); }
  });

  router.put('/team-chat/threads/:threadId/follow-state', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = z.object({ following: z.boolean() }).parse(req.body);
      const result = await service.setThreadFollowState(requireWorkspaceId(req), req.params.threadId, user.userId, input.following);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to update follow state'); }
  });

  // Deep-link compatibility: resolve the owning thread for a message id.
  router.get('/team-chat/messages/:messageId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const resolved = await service.resolveThreadForMessage(requireWorkspaceId(req), req.params.messageId, user.userId);
      res.json(resolved);
    } catch (error) { handleError(res, error, 'Failed to resolve message'); }
  });

  // --- Release B: attributed changes (F6) --------------------------------

  router.get('/team-chat/threads/:threadId/changes', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const query = z.object({
        runId: z.string().max(255).optional(),
        cursor: z.string().max(4_000).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }).parse(req.query);
      const result = await service.listThreadChanges(requireWorkspaceId(req), req.params.threadId, user.userId, query);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to load changes'); }
  });

  // Authorized immutable version bytes for a Changes record — works for DELETED
  // files (reads the immutable file_versions row, not the live files row). Unsafe
  // active types (html/svg) are served as attachments to avoid same-origin
  // script execution; the frontend fetches as text/bytes for diffs/preview.
  router.get('/team-chat/threads/:threadId/changes/:versionId/content', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { side } = z.object({ side: z.enum(['before', 'after']).default('after') }).parse(req.query);
      const result = await service.readThreadChangeVersionBytes(
        requireWorkspaceId(req), req.params.threadId, req.params.versionId, user.userId, side,
      );
      const safeName = (result.name.split(/[/\\]/).pop() || 'version').replace(/["\\\r\n]/g, '_');
      const unsafeActive = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml)/i.test(result.mimeType);
      res.setHeader('Content-Type', unsafeActive ? 'application/octet-stream' : result.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      // Never render potentially-active uploaded content inline as a same-origin
      // page; force download. Safe types can be inlined for preview/diff.
      res.setHeader('Content-Disposition', `${unsafeActive ? 'attachment' : 'inline'}; filename="${safeName}"`);
      res.send(result.buffer);
    } catch (error) { handleError(res, error, 'Failed to load change version content'); }
  });

  router.get('/team-chat/threads/:threadId/history', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const query = z.object({
        fromSeq: z.coerce.number().int().nonnegative(),
        toSeq: z.coerce.number().int().nonnegative(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }).parse(req.query);
      const result = await service.readThreadHistoryRange(requireWorkspaceId(req), user.userId, req.params.threadId, query.fromSeq, query.toSeq, { limit: query.limit });
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to read thread history'); }
  });

  // --- Release B: annotation/object thread links + anchors (F8) ----------

  router.get('/team-chat/threads/:threadId/linked-items', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const result = await service.listThreadLinkedItems(requireWorkspaceId(req), req.params.threadId, user.userId);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to load linked items'); }
  });

  router.post('/objects/:objectId/reattach-anchor', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = z.object({
        anchorVersionId: z.string().uuid(),
        anchorStart: z.number().int().nonnegative().optional(),
        anchorEnd: z.number().int().nonnegative().optional(),
        anchorText: z.string().max(4_000).optional(),
        blockId: z.string().trim().max(255).optional(),
        anchorFingerprint: z.string().trim().max(255).optional(),
      }).superRefine((p, ctx) => {
        if (p.anchorStart !== undefined && p.anchorEnd !== undefined && p.anchorEnd < p.anchorStart) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'anchorEnd must be >= anchorStart', path: ['anchorEnd'] });
        }
      }).parse(req.body ?? {});
      const object = await service.reattachAnchor(requireWorkspaceId(req), req.params.objectId, user.userId, input);
      res.json(object);
    } catch (error) { handleError(res, error, 'Failed to reattach anchor'); }
  });

  // --- Release B: frozen submissions and review (F7) ---------------------

  router.post('/objects/:objectId/submissions', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = submissionSchema.parse(req.body);
      const submission = await service.submitProposalChangeSet(requireWorkspaceId(req), req.params.objectId, user.userId, input);
      res.status(201).json(submission);
    } catch (error) { handleError(res, error, 'Failed to submit change set'); }
  });

  // Pre-submit candidates: server-derived diff (create/content/delete/rename +
  // required asset groups). Author-only.
  router.get('/objects/:objectId/submission-candidates', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const query = z.object({ expectedSharedRevision: z.coerce.number().int().nonnegative() }).parse(req.query);
      const result = await service.listSubmissionCandidates(requireWorkspaceId(req), req.params.objectId, user.userId, query);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to load submission candidates'); }
  });

  // List submissions with review history (author/reviewer).
  router.get('/objects/:objectId/submissions', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const result = await service.listSubmissions(requireWorkspaceId(req), req.params.objectId, user.userId);
      res.json(result);
    } catch (error) { handleError(res, error, 'Failed to list submissions'); }
  });

  // Authenticated proposal-owned snapshot bytes for a shared reviewer, scoped by
  // submission + operation index + side. Unsafe active types served as
  // attachments; never exposes a private/raw object key.
  router.get('/objects/:objectId/submissions/:submissionId/operations/:opIndex/content', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { opIndex, side } = z.object({
        opIndex: z.coerce.number().int().nonnegative(),
        side: z.enum(['before', 'after']).default('after'),
      }).parse({ opIndex: req.params.opIndex, side: req.query.side });
      const result = await service.readSubmissionOperationBytes(
        requireWorkspaceId(req), req.params.objectId, req.params.submissionId, opIndex, user.userId, side,
      );
      const safeName = (result.name.split(/[/\\]/).pop() || 'version').replace(/["\\\r\n]/g, '_');
      const unsafeActive = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml)/i.test(result.mimeType);
      res.setHeader('Content-Type', unsafeActive ? 'application/octet-stream' : result.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `${unsafeActive ? 'attachment' : 'inline'}; filename="${safeName}"`);
      res.send(result.buffer);
    } catch (error) { handleError(res, error, 'Failed to load submission content'); }
  });

  router.get('/objects/:objectId/submissions/:submissionId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const submission = await service.getSubmission(requireWorkspaceId(req), req.params.objectId, req.params.submissionId, user.userId);
      res.json(submission);
    } catch (error) { handleError(res, error, 'Failed to load submission'); }
  });

  router.post('/objects/:objectId/submissions/:submissionId/reviews', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const input = reviewSchema.parse(req.body);
      const review = await service.reviewSubmission(requireWorkspaceId(req), req.params.objectId, req.params.submissionId, user.userId, input);
      res.status(201).json(review);
    } catch (error) { handleError(res, error, 'Failed to record review'); }
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

  // Author-only private navigation for a proposal (linked private workspace id +
  // revision + origin threads). Non-authors are denied; public object/list
  // responses never carry the private workspace id.
  router.get('/objects/:objectId/private-navigation', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const nav = await service.getProposalPrivateNavigation(requireWorkspaceId(req), req.params.objectId, user.userId);
      res.json(nav);
    } catch (error) { handleError(res, error, 'Failed to load private navigation'); }
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
      const input = z.object({ sourceThreadId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
      const object = await service.convertToProposal(
        requireWorkspaceId(req),
        req.params.objectId,
        user.userId,
        { sourceThreadId: input.sourceThreadId },
      );
      res.json(object);
    } catch (error) {
      handleError(res, error, 'Failed to create change proposal');
    }
  });

  router.post('/objects/:objectId/apply', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const parsed = z.object({
        submissionId: z.string().uuid().optional(),
        expectedSharedRevision: z.number().int().nonnegative().optional(),
      }).parse(req.body ?? {});
      // Thread-linked/frozen proposals apply via the submission path; legacy
      // whole-copy proposals continue to use applyProposal (which now rejects
      // thread-linked/submitted proposals to prevent bypass).
      const object = parsed.submissionId !== undefined
        ? await service.applySubmission(requireWorkspaceId(req), req.params.objectId, user.userId, {
            submissionId: parsed.submissionId,
            expectedSharedRevision: parsed.expectedSharedRevision ?? 0,
          })
        : await service.applyProposal(requireWorkspaceId(req), req.params.objectId, user.userId);
      res.json(object);
    } catch (error) {
      handleError(res, error, 'Failed to apply change proposal');
    }
  });

  return router;
}
