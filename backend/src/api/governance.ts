import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SkillGovernanceService } from '../services/governance/skillGovernanceService';
import { SkillGovernanceError } from '../services/governance/skillGovernanceService';
import { HttpError } from '../errors';

const createDraftSchema = z.object({
  proposalType: z.enum(['new', 'improvement']),
  sourceSkillId: z.string().optional(),
  sourceVersionId: z.string().uuid().optional(),
}).refine((value) => value.proposalType === 'new' || Boolean(value.sourceSkillId), {
  message: 'sourceSkillId is required for an improvement',
  path: ['sourceSkillId'],
});

const draftFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64']).optional(),
  executable: z.boolean().optional(),
});

const updateDraftSchema = z.object({
  displayName: z.string().max(255).optional(),
  description: z.string().max(10_000).optional(),
  proposedSkillKey: z.string().max(128).optional(),
  proposedOwnerTeamId: z.string().uuid().nullable().optional(),
  files: z.array(draftFileSchema).max(100).optional(),
  deletePaths: z.array(z.string().min(1)).max(100).optional(),
  expectedDraftRevision: z.number().int().nonnegative().optional(),
});

const submitDraftSchema = z.object({
  owningTeamId: z.string().uuid().optional(),
  semanticVersion: z.string().min(5).max(64),
  submissionNote: z.string().max(10_000).optional(),
  expectedDraftRevision: z.number().int().nonnegative(),
});

const reviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'request_changes', 'reject']),
  comment: z.string().max(10_000).optional(),
  expectedRequestRevision: z.number().int().positive(),
  leavePreviousDefault: z.boolean().optional(),
});

const retryActivationSchema = z.object({
  expectedRequestRevision: z.number().int().positive(),
});

const defaultVersionSchema = z.object({
  versionId: z.string().uuid(),
});

const transferSchema = z.object({
  ownerTeamId: z.string().uuid(),
});

const workspacePinSchema = z.object({
  skillId: z.string().min(1),
  versionId: z.string().uuid(),
});

const teamLeadSchema = z.object({
  userId: z.string().uuid(),
  enabled: z.boolean(),
});

const requireUser = (req: Request) => {
  if (!req.userContext) {
    throw new SkillGovernanceError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }
  return req.userContext;
};

const expectedRevision = (req: Request, bodyValue?: number): number => {
  if (Number.isInteger(bodyValue)) return Number(bodyValue);
  const raw = String(req.header('if-match') || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 0) {
    throw new SkillGovernanceError(428, 'SKILL_PRECONDITION_REQUIRED', 'If-Match or an expected revision is required');
  }
  return parsed;
};

const sendResource = (res: Response, body: any) => {
  const revision = body?.draftRevision ?? body?.requestRevision;
  if (revision !== undefined) res.setHeader('ETag', `"${revision}"`);
  return res.json(body);
};

const parsePagination = (req: Request) => ({
  limit: Number(req.query.limit || 50),
  offset: Number(req.query.offset || 0),
});

const handleError = (res: Response, error: unknown) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: error.issues[0]?.message || 'Invalid request',
      code: 'INVALID_SKILL_MANIFEST',
      issues: error.issues,
    });
  }
  if (error instanceof SkillGovernanceError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
  }
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message, details: error.details });
  }
  console.error('Governance request failed', error);
  return res.status(500).json({ error: 'Governance request failed', code: 'GOVERNANCE_INTERNAL_ERROR' });
};

export default function governanceRoutes(service: SkillGovernanceService) {
  const router = Router();

  router.get('/skills/mine', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listMySkills(user.userId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skills/drafts', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = createDraftSchema.parse(req.body);
      const result = await service.runIdempotent(
        user.userId,
        'skill_draft.create',
        req.header('idempotency-key') || undefined,
        payload,
        () => service.createDraft(user.userId, payload),
      );
      res.setHeader('Idempotency-Replayed', String(result.replayed));
      return sendResource(res.status(result.replayed ? 200 : 201), result.body);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/skills/drafts/:draftId', async (req, res) => {
    try {
      const user = requireUser(req);
      return sendResource(res, await service.getDraft(user.userId, req.params.draftId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.patch('/skills/drafts/:draftId', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = updateDraftSchema.parse(req.body);
      const revision = expectedRevision(req, payload.expectedDraftRevision);
      const { expectedDraftRevision: _expected, ...mutation } = payload;
      return sendResource(res, await service.updateDraft(user.userId, req.params.draftId, revision, mutation));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skills/drafts/:draftId/actions', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = updateDraftSchema.parse(req.body);
      const revision = expectedRevision(req, payload.expectedDraftRevision);
      const { expectedDraftRevision: _expected, ...mutation } = payload;
      return sendResource(res, await service.updateDraft(user.userId, req.params.draftId, revision, mutation));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skills/drafts/:draftId/validate', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.validateDraft(user.userId, req.params.draftId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skills/drafts/:draftId/submit', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = submitDraftSchema.parse(req.body);
      const result = await service.runIdempotent(
        user.userId,
        `skill_draft.submit:${req.params.draftId}`,
        req.header('idempotency-key') || undefined,
        payload,
        () => service.submitDraft(user.userId, req.params.draftId, payload),
      );
      res.setHeader('Idempotency-Replayed', String(result.replayed));
      return sendResource(res, result.body);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/teams/mine', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json({ teams: await service.listEligibleTeams(user.userId) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/teams/:teamId/lead', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = teamLeadSchema.parse(req.body);
      return res.json(await service.setTeamLead(user.userId, req.params.teamId, payload.userId, payload.enabled));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/teams/:teamId/skill-reviews', async (req, res) => {
    try {
      const user = requireUser(req);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      return res.json(await service.listTeamReviews(user.userId, req.params.teamId, status, parsePagination(req)));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/skill-reviews/:requestId/events', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listReviewEvents(user.userId, req.params.requestId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/skill-reviews/:requestId', async (req, res) => {
    try {
      const user = requireUser(req);
      return sendResource(res, await service.getReview(user.userId, req.params.requestId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skill-reviews/:requestId/decision', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = reviewDecisionSchema.parse(req.body);
      const result = await service.runIdempotent(
        user.userId,
        `skill_review.decision:${req.params.requestId}`,
        req.header('idempotency-key') || undefined,
        payload,
        () => service.decideReview(user.userId, req.params.requestId, payload),
      );
      res.setHeader('Idempotency-Replayed', String(result.replayed));
      return sendResource(res, result.body);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/skill-reviews/:requestId/actions/retry-activation', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = retryActivationSchema.parse(req.body);
      const result = await service.runIdempotent(
        user.userId,
        `skill_review.retry_activation:${req.params.requestId}`,
        req.header('idempotency-key') || undefined,
        payload,
        () => service.retryReviewActivation(
          user.userId,
          req.params.requestId,
          payload.expectedRequestRevision,
        ),
      );
      res.setHeader('Idempotency-Replayed', String(result.replayed));
      return sendResource(res, result.body);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/skills/catalog', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.catalog(user.userId, parsePagination(req)));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/skills/:skillId/versions', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listVersions(user.userId, req.params.skillId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/teams/:teamId/skill-grants/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.setTeamSkillGrant(user.userId, req.params.teamId, req.params.skillId, true));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.delete('/teams/:teamId/skill-grants/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.setTeamSkillGrant(user.userId, req.params.teamId, req.params.skillId, false));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/users/:userId/skill-grants/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.setUserSkillGrant(user.userId, req.params.userId, req.params.skillId, true));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.delete('/users/:userId/skill-grants/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.setUserSkillGrant(user.userId, req.params.userId, req.params.skillId, false));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/skills/:skillId/default-version', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = defaultVersionSchema.parse(req.body);
      return res.json(await service.setDefaultVersion(user.userId, req.params.skillId, payload.versionId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  for (const action of ['suspend', 'restore', 'retire'] as const) {
    router.post(`/skills/:skillId/versions/:versionId/${action}`, async (req, res) => {
      try {
        const user = requireUser(req);
        const result = await service.runIdempotent(
          user.userId,
          `skill_version.${action}:${req.params.versionId}`,
          req.header('idempotency-key') || undefined,
          req.body,
          () => service.setVersionStatus(user.userId, req.params.skillId, req.params.versionId, action),
        );
        res.setHeader('Idempotency-Replayed', String(result.replayed));
        return res.json(result.body);
      } catch (error) {
        return handleError(res, error);
      }
    });
  }

  router.post('/skills/:skillId/transfer', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = transferSchema.parse(req.body);
      const result = await service.runIdempotent(
        user.userId,
        `skill.transfer:${req.params.skillId}`,
        req.header('idempotency-key') || undefined,
        payload,
        () => service.transferSkill(user.userId, req.params.skillId, payload.ownerTeamId),
      );
      res.setHeader('Idempotency-Replayed', String(result.replayed));
      return res.json(result.body);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/skill-pins', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listWorkspacePins(user.userId, req.params.workspaceId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/workspaces/:workspaceId/skill-pins/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      const payload = workspacePinSchema.parse({ ...req.body, skillId: req.params.skillId });
      return res.json(await service.pinWorkspaceSkill(user.userId, req.params.workspaceId, payload.skillId, payload.versionId));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/skill-authorization/:skillId', async (req, res) => {
    try {
      const user = requireUser(req);
      const result = await service.authorizeInvocation(user.userId, req.params.workspaceId, req.params.skillId);
      return res.status(result.allowed ? 200 : 403).json(result);
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/notifications', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listNotifications(user.userId, req.query.unread === 'true'));
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/governance/audit-events', async (req, res) => {
    try {
      const user = requireUser(req);
      return res.json(await service.listAuditEvents(user.userId, {
        resourceType: typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined,
        resourceId: typeof req.query.resourceId === 'string' ? req.query.resourceId : undefined,
        action: typeof req.query.action === 'string' ? req.query.action : undefined,
        ...parsePagination(req),
      }));
    } catch (error) {
      return handleError(res, error);
    }
  });

  return router;
}
