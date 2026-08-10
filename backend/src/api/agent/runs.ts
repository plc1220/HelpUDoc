import { Router, type Request, type Response } from 'express';
import path from 'path';
import { z } from 'zod';
import type { TaggedFileRef } from '@helpudoc/contracts/types';
import { runAgent, runAgentStream, type AgentMessageContentBlock } from '../../services/agentService';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import type { GoogleOAuthService } from '../../services/googleOAuthService';
import type { UserService } from '../../services/userService';
import type { ConversationService } from '../../services/conversationService';
import type { KnowledgeService } from '../../services/knowledgeService';
import { HttpError, NotFoundError } from '../../errors';
import {
  cancelAgentRun,
  getRunMeta,
  getRunStreamKey,
  resumeAgentRun,
  resumeAgentRunWithAction,
  resumeAgentRunWithResponse,
  startAgentRun,
} from '../../services/agentRunService';
import { blockingRedisClient } from '../../services/redisService';
import { createAgentPolicyApi } from './policy';
import { safeErrorForLog } from '../../lib/safeError';

const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';
const DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES = 8 * 1024 * 1024;

const resolveCurrentTurnMultimodalMaxBytes = (): number => {
  const raw = Number(process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES || DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES;
};

const CURRENT_TURN_MULTIMODAL_MAX_BYTES = resolveCurrentTurnMultimodalMaxBytes();

const runAgentSchema = z.object({
  persona: z.string().min(1),
  prompt: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().optional(),
  history: z.array(z.object({
    role: z.string().min(1),
    content: z.string().min(1),
  })).optional(),
  forceReset: z.boolean().optional(),
  turnId: z.string().optional(),
  taggedFiles: z.array(z.string().min(1)).optional(),
  taggedFileRefs: z.array(z.object({
    fileId: z.number().int().positive(),
    version: z.number().int().positive().optional(),
    name: z.string().trim().min(1).optional(),
  })).max(50).optional(),
  currentTurnFileIds: z.array(z.number().int().positive()).optional(),
  internetSearchEnabled: z.boolean().optional(),
  knowledgeRefs: z.array(z.object({ id: z.number().int().positive() })).max(20).optional(),
});

const runDecisionSchema = z.object({
  decision: z.enum(['approve', 'edit', 'reject']),
  editedAction: z
    .object({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  message: z.string().optional(),
});
const runResponseSchema = z.object({
  message: z.string().optional(),
  selectedChoiceIds: z.array(z.string().min(1)).optional(),
  selectedValues: z.array(z.string()).optional(),
  answersByQuestionId: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});
const runActionSchema = z.object({
  actionId: z.string().min(1),
  text: z.string().optional(),
});

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
  console.error(fallbackMessage, safeErrorForLog(error));
  return res.status(500).json({ error: fallbackMessage });
};

const normalizeTaggedValue = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\/+/, '');

export type TaggedFileRefInput = TaggedFileRef;

export type ResolvedTaggedFileRef = {
  fileId: number;
  version: number;
  name: string;
  path: string;
  mimeType: string;
};

type TaggedFileRecord = {
  id: number | string;
  name?: string | null;
  mimeType?: string | null;
  version?: number | string | null;
  [key: string]: unknown;
};

type TaggedFileResolver = Pick<FileService, 'getFiles' | 'ensureLocalMirror'> & {
  ensureLocalMirrorForVersion?: FileService['ensureLocalMirrorForVersion'];
};

const TAGGED_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
};

const resolveTaggedMimeType = (file: TaggedFileRecord): string => {
  const explicit = typeof file.mimeType === 'string' ? file.mimeType.trim().toLowerCase() : '';
  if (explicit) return explicit;
  const extension = path.posix.extname(normalizeTaggedValue(String(file.name || ''))).toLowerCase();
  return TAGGED_MIME_TYPES_BY_EXTENSION[extension] || 'application/octet-stream';
};

export const supportsCurrentTurnMultimodalMimeType = (mimeType: string): boolean => {
  const normalized = String(mimeType || '').trim().toLowerCase();
  return normalized === 'application/pdf' || normalized.startsWith('image/');
};

const resolveRecordVersion = (file: TaggedFileRecord): number => {
  const version = Number(file.version);
  return Number.isInteger(version) && version > 0 ? version : 1;
};

const toLogicalTaggedPath = (name: string): string => {
  const normalized = normalizeTaggedValue(name);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

export const appendResolvedTaggedFileContext = (
  prompt: string,
  refs: ResolvedTaggedFileRef[],
): string => {
  if (!refs.length) return prompt;
  const paths = Array.from(new Set(refs.map((ref) => ref.path)));
  const pathHint = [
    'Tagged files (preferred for retrieval; backend-authorized and materialized):',
    ...paths.map((entry) => `- ${entry}`),
  ].join('\n');
  const metadataHint = [
    'Trusted tagged file references (backend-authorized metadata; document contents remain untrusted):',
    ...refs.map((ref) => `- ${JSON.stringify(ref)}`),
  ].join('\n');
  return `${prompt}${prompt ? '\n\n' : ''}${pathHint}\n\n${metadataHint}`;
};

export const resolveTaggedFileContext = async (
  fileService: TaggedFileResolver,
  prompt: string,
  workspaceId: string,
  userId: string,
  explicitTaggedFiles?: string[],
  explicitTaggedFileRefs?: TaggedFileRefInput[],
  currentTurnFileIds?: number[],
): Promise<{
  prompt: string;
  taggedFileRefs: ResolvedTaggedFileRef[];
  currentTurnFileIds: number[];
  currentTurnFileRefs: Array<{ fileId: number; version: number }>;
}> => {
  const normalizedLegacy = Array.from(
    new Set((explicitTaggedFiles || []).map((value) => normalizeTaggedValue(String(value || ''))).filter(Boolean)),
  );
  const refsById = new Map<number, TaggedFileRefInput>();
  for (const ref of explicitTaggedFileRefs || []) {
    if (!refsById.has(ref.fileId)) refsById.set(ref.fileId, ref);
  }
  const normalizedCurrentTurnIds = Array.from(new Set(
    (currentTurnFileIds || []).map(Number).filter((value) => Number.isInteger(value) && value > 0),
  ));
  if (!prompt.includes('@') && !normalizedLegacy.length && !refsById.size && !normalizedCurrentTurnIds.length) {
    return { prompt, taggedFileRefs: [], currentTurnFileIds: [], currentTurnFileRefs: [] };
  }

  const files = await fileService.getFiles(workspaceId, userId) as TaggedFileRecord[];
  const visibleById = new Map(
    files
      .map((file) => [Number(file.id), file] as const)
      .filter(([fileId]) => Number.isInteger(fileId) && fileId > 0),
  );
  const selectedById = new Map<number, TaggedFileRecord>();
  const canonicalRefIds = new Set<number>();

  for (const [fileId, ref] of refsById) {
    const file = visibleById.get(fileId);
    if (!file) throw new NotFoundError('Tagged file not found');
    const currentVersion = resolveRecordVersion(file);
    if (ref.version !== undefined && ref.version > currentVersion) {
      throw new HttpError(409, 'Tagged file version conflict', {
        fileId,
        expectedVersion: ref.version,
        currentVersion,
      });
    }
    canonicalRefIds.add(fileId);
    selectedById.set(fileId, file);
  }

  const legacyBasenames = new Set(normalizedLegacy.map((value) => path.posix.basename(value)));
  for (const file of files) {
    const fileId = Number(file.id);
    const fileName = typeof file.name === 'string' ? normalizeTaggedValue(file.name) : '';
    if (!fileName || !Number.isInteger(fileId) || fileId < 1) continue;
    const legacyMatch = normalizedLegacy.length > 0 && (
      normalizedLegacy.includes(fileName) || legacyBasenames.has(path.posix.basename(fileName))
    );
    const mentionMatch = refsById.size === 0 && normalizedLegacy.length === 0 && prompt.includes(`@${file.name}`);
    if (legacyMatch || mentionMatch) selectedById.set(fileId, file);
  }

  const resolvedRefs: ResolvedTaggedFileRef[] = [];
  for (const [fileId, file] of selectedById) {
    const name = normalizeTaggedValue(String(file.name || ''));
    if (!name) continue;
    const requestedVersion = refsById.get(fileId)?.version || resolveRecordVersion(file);
    if (fileService.ensureLocalMirrorForVersion) {
      await fileService.ensureLocalMirrorForVersion(file, requestedVersion);
    } else {
      await fileService.ensureLocalMirror(file);
    }
    const materializedName = requestedVersion === resolveRecordVersion(file)
      ? name
      : path.posix.join(
          '.system', 'tagged-versions', String(fileId), `v${requestedVersion}`, path.posix.basename(name),
        );
    resolvedRefs.push({
      fileId,
      version: requestedVersion,
      name,
      path: toLogicalTaggedPath(materializedName),
      mimeType: resolveTaggedMimeType(file),
    });
  }

  const multimodalIds = new Set<number>();
  const multimodalVersions = new Map<number, number>();
  for (const fileId of normalizedCurrentTurnIds) {
    const file = visibleById.get(fileId);
    if (!file) throw new NotFoundError('Current-turn attachment not found');
    if (supportsCurrentTurnMultimodalMimeType(resolveTaggedMimeType(file))) {
      multimodalIds.add(fileId);
      multimodalVersions.set(fileId, resolveRecordVersion(file));
    }
  }
  for (const ref of resolvedRefs) {
    if (canonicalRefIds.has(ref.fileId) && supportsCurrentTurnMultimodalMimeType(ref.mimeType)) {
      multimodalIds.add(ref.fileId);
      multimodalVersions.set(ref.fileId, ref.version);
    }
  }

  return {
    prompt: appendResolvedTaggedFileContext(prompt, resolvedRefs),
    taggedFileRefs: resolvedRefs,
    currentTurnFileIds: Array.from(multimodalIds),
    currentTurnFileRefs: Array.from(multimodalIds).map((fileId) => ({
      fileId,
      version: multimodalVersions.get(fileId) || resolveRecordVersion(visibleById.get(fileId) || { id: fileId }),
    })),
  };
};

export function registerRunRoutes(
  router: Router,
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
  conversationService: ConversationService,
  knowledgeService: KnowledgeService,
) {
  const policyApi = createAgentPolicyApi(googleOAuthService, userService);
  const ensureRunAccess = async (
    meta: NonNullable<Awaited<ReturnType<typeof getRunMeta>>>,
    userId: string,
  ) => {
    if (meta.userId && meta.userId !== userId) {
      throw new NotFoundError('Run not found');
    }
    await workspaceService.ensureMembership(meta.workspaceId, userId);
  };

  const resolveKnowledgeContext = async (
    prompt: string,
    userId: string,
    refs?: Array<{ id: number }>,
  ) => {
    const resolved = await knowledgeService.resolveTaggedKnowledgeRefs(
      userId,
      (refs || []).map((ref) => ref.id),
    );
    if (!resolved.length) return { prompt, knowledgeRefs: [] };
    const guidance = [
      'Tagged Knowledge bundles (the only Knowledge scope for this turn):',
      ...resolved.map((ref) => `- ${ref.title} (knowledge://${ref.id}/index.md)`),
      'Use knowledge_read or knowledge_search only within these selected bundles.',
    ].join('\n');
    return {
      prompt: `${prompt.trim()}\n\n${guidance}`,
      knowledgeRefs: resolved,
    };
  };

  const buildCurrentTurnMessageContent = async (
    workspaceId: string,
    userId: string,
    prompt: string,
    currentTurnFileRefs?: Array<{ fileId: number; version: number }>,
  ): Promise<AgentMessageContentBlock[] | undefined> => {
    const normalizedRefs = Array.from(new Map(
      (currentTurnFileRefs || [])
        .filter((ref) => Number.isInteger(ref.fileId) && ref.fileId > 0 && Number.isInteger(ref.version) && ref.version > 0)
        .map((ref) => [ref.fileId, ref] as const),
    ).values());
    if (!normalizedRefs.length) {
      return undefined;
    }

    const fileBlocks: AgentMessageContentBlock[] = [];

    for (const ref of normalizedRefs) {
      const fileId = ref.fileId;
      const download = await fileService.getFileDownload(fileId, userId, ref.version);
      const mimeType = typeof download.mimeType === 'string' && download.mimeType.trim()
        ? download.mimeType.trim()
        : 'application/octet-stream';
      const encoded = download.buffer.toString('base64');
      if (!encoded) {
        continue;
      }
      const byteLength = Buffer.byteLength(encoded, 'base64');
      if (byteLength > CURRENT_TURN_MULTIMODAL_MAX_BYTES) {
        console.info('Skipping oversized current-turn multimodal attachment', {
          workspaceId,
          fileId,
          fileName: download.name,
          mimeType,
          byteLength,
          maxBytes: CURRENT_TURN_MULTIMODAL_MAX_BYTES,
        });
        continue;
      }
      if (mimeType === 'application/pdf') {
        fileBlocks.push({
          type: 'file',
          base64: encoded,
          mime_type: mimeType,
          filename: String(download.name || `attachment-${fileId}.pdf`),
        });
      } else if (mimeType.startsWith('image/')) {
        fileBlocks.push({
          type: 'image',
          base64: encoded,
          mime_type: mimeType,
        });
      }
    }

    if (!fileBlocks.length) {
      return undefined;
    }

    const promptText = [
      prompt.trim(),
      'Use the attached file content as primary context for this turn before falling back to workspace search or web search.',
    ]
      .filter(Boolean)
      .join('\n\n');

    return promptText
      ? [{ type: 'text', text: promptText }, ...fileBlocks]
      : fileBlocks;
  };

  router.post('/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, taggedFileRefs, currentTurnFileIds, internetSearchEnabled, knowledgeRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const taggedContext = await resolveTaggedFileContext(
        fileService,
        prompt,
        workspaceId,
        user.userId,
        taggedFiles,
        taggedFileRefs,
        currentTurnFileIds,
      );
      const knowledgeContext = await resolveKnowledgeContext(taggedContext.prompt, user.userId, knowledgeRefs);
      const enrichedPrompt = knowledgeContext.prompt;
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(
        workspaceId,
        user.userId,
        enrichedPrompt,
        taggedContext.currentTurnFileRefs,
      );
      const response = await runAgent(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        authToken: authToken || undefined,
        messageContent,
        internetSearchEnabled,
        knowledgeRefs: knowledgeContext.knowledgeRefs,
        traceContext: {
          userId: user.userId,
          workspaceId,
          persona,
        },
      });
      res.json(response);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to run agent');
    }
  });

  router.post('/run-stream', async (req, res) => {
    const upstreamAbort = new AbortController();
    let streamResponse: Awaited<ReturnType<typeof runAgentStream>> | null = null;
    let cleanedUp = false;

    const cleanupListeners = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      req.off('close', handleClientClose);
      res.off('close', handleClientClose);
    };

    const handleClientClose = () => {
      upstreamAbort.abort();
      if (streamResponse?.data && !streamResponse.data.destroyed) {
        streamResponse.data.destroy();
      }
      cleanupListeners();
    };

    req.on('close', handleClientClose);
    res.on('close', handleClientClose);

    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, taggedFileRefs, currentTurnFileIds, internetSearchEnabled, knowledgeRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const taggedContext = await resolveTaggedFileContext(
        fileService,
        prompt,
        workspaceId,
        user.userId,
        taggedFiles,
        taggedFileRefs,
        currentTurnFileIds,
      );
      const knowledgeContext = await resolveKnowledgeContext(taggedContext.prompt, user.userId, knowledgeRefs);
      const enrichedPrompt = knowledgeContext.prompt;
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(
        workspaceId,
        user.userId,
        enrichedPrompt,
        taggedContext.currentTurnFileRefs,
      );
      streamResponse = await runAgentStream(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        signal: upstreamAbort.signal,
        authToken: authToken || undefined,
        messageContent,
        internetSearchEnabled,
        knowledgeRefs: knowledgeContext.knowledgeRefs,
        traceContext: {
          userId: user.userId,
          workspaceId,
          persona,
        },
      });
      res.setHeader('Content-Type', 'application/jsonl');
      streamResponse.data.on('data', (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });
      streamResponse.data.on('end', () => {
        if (!res.writableEnded) {
          res.end();
        }
        cleanupListeners();
      });
      streamResponse.data.on('error', (error: Error) => {
        console.error('Agent stream error', safeErrorForLog(error));
        if (!res.headersSent) {
          res.status(500).json({ error: 'Agent stream failed' });
        } else if (!res.writableEnded) {
          res.end();
        }
        cleanupListeners();
      });
    } catch (error: any) {
      cleanupListeners();
      if (error?.code === 'ERR_CANCELED') {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to stream agent response');
    }
  });

  router.post('/runs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, conversationId, history, forceReset, turnId, taggedFiles, taggedFileRefs, currentTurnFileIds, internetSearchEnabled, knowledgeRefs } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId);
      if (conversationId) {
        await conversationService.ensureConversationAccess(user.userId, workspaceId, conversationId);
      }
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const taggedContext = await resolveTaggedFileContext(
        fileService,
        prompt,
        workspaceId,
        user.userId,
        taggedFiles,
        taggedFileRefs,
        currentTurnFileIds,
      );
      const knowledgeContext = await resolveKnowledgeContext(taggedContext.prompt, user.userId, knowledgeRefs);
      const enrichedPrompt = knowledgeContext.prompt;
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(
        workspaceId,
        user.userId,
        enrichedPrompt,
        taggedContext.currentTurnFileRefs,
      );
      const { runId, status } = await startAgentRun({
        persona,
        workspaceId,
        conversationId,
        prompt: enrichedPrompt,
        userId: user.userId,
        history,
        forceReset,
        turnId,
        authToken: authToken || undefined,
        messageContent,
        internetSearchEnabled,
        knowledgeRefs: knowledgeContext.knowledgeRefs,
      });
      res.json({ runId, status });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to start agent run');
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(req.params.runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      res.json(meta);
    } catch (error) {
      handleError(res, error, 'Failed to fetch run status');
    }
  });

  router.post('/runs/:runId/cancel', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(req.params.runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      await cancelAgentRun(req.params.runId);
      res.json({ status: 'cancelled' });
    } catch (error) {
      handleError(res, error, 'Failed to cancel run');
    }
  });

  router.post('/runs/:runId/decision', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting approval' });
      }
      if (meta.pendingInterrupt?.kind === 'clarification') {
        return res.status(409).json({ error: 'Run is awaiting a clarification response, not an approval decision' });
      }
      const payload = runDecisionSchema.parse(req.body);
      console.info('[AgentDecision]', {
        runId,
        workspaceId: meta.workspaceId,
        decision: payload.decision,
        status: meta.status,
        hasInterruptId: Boolean(meta.pendingInterrupt?.interruptId),
      });
      const decisions = [
        payload.decision === 'edit'
          ? {
              type: 'edit' as const,
              edited_action: {
                name: payload.editedAction?.name || 'request_plan_approval',
                args: payload.editedAction?.args || {},
              },
              message: payload.message,
            }
          : payload.decision === 'reject'
            ? { type: 'reject' as const, message: payload.message || 'Rejected by user' }
            : { type: 'approve' as const },
      ];
      const result = await resumeAgentRun(runId, decisions, {
        authToken: authToken || undefined,
        interruptId: meta.pendingInterrupt?.interruptId,
      });
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to submit run decision');
    }
  });

  router.post('/runs/:runId/respond', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting input' });
      }
      const interruptKind = meta.pendingInterrupt?.kind ?? 'approval';
      if (interruptKind !== 'clarification') {
        return res.status(409).json({ error: 'Run is awaiting an approval decision, not a clarification response' });
      }
      const payload = runResponseSchema.parse(req.body);
      if (!payload.message && !payload.selectedChoiceIds?.length && !payload.selectedValues?.length) {
        const hasStructuredAnswers = Boolean(
          payload.answersByQuestionId && Object.keys(payload.answersByQuestionId).length,
        );
        if (!hasStructuredAnswers) {
          return res.status(400).json({ error: 'Clarification response requires a message or a selected choice' });
        }
      }
      const result = await resumeAgentRunWithResponse(runId, {
        message: payload.message,
        selectedChoiceIds: payload.selectedChoiceIds,
        selectedValues: payload.selectedValues,
        answersByQuestionId: payload.answersByQuestionId,
      }, {
        authToken: authToken || undefined,
        previousInterrupt: meta.pendingInterrupt,
      });
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to submit clarification response');
    }
  });

  router.post('/runs/:runId/act', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId);
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: workspacePolicy.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting human input' });
      }
      const payload = runActionSchema.parse(req.body);
      const interruptActions = Array.isArray(meta.pendingInterrupt?.actions) ? meta.pendingInterrupt.actions : [];
      const action = interruptActions.find((item) => item.id === payload.actionId);
      if (!action) {
        return res.status(404).json({ error: `Interrupt action "${payload.actionId}" was not found` });
      }
      if (action.inputMode === 'text' && !payload.text?.trim()) {
        return res.status(400).json({ error: 'This action requires text input' });
      }
      const result = await resumeAgentRunWithAction(
        runId,
        {
          action: {
            id: action.id,
            ...(typeof action.value === 'string' ? { value: action.value } : {}),
            ...(action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
              ? { payload: action.payload }
              : {}),
            ...(payload.text?.trim() ? { text: payload.text.trim() } : {}),
          },
        },
        {
          authToken: authToken || undefined,
        },
      );
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid interrupt action payload' });
      }
      handleError(res, error, 'Failed to submit interrupt action');
    }
  });

  router.get('/runs/:runId/stream', async (req, res) => {
    const { runId } = req.params;
    const after = typeof req.query.after === 'string' && req.query.after.trim() ? req.query.after : '0-0';
    const abortController = new AbortController();

    let streamKey: string | null = null;
    let terminalStatus: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | null = null;

    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await ensureRunAccess(meta, user.userId);
      streamKey = getRunStreamKey(runId);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return handleError(res, error, 'Failed to authorize run stream');
    }

    const cleanup = () => {
      abortController.abort();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as any).flushHeaders?.();
    if (DEBUG_AGENT_RUN_STREAM) {
      console.info('[agent-run-stream] client connected', { runId, after });
    }

    const readLoop = async () => {
      if (!streamKey) {
        return;
      }
      let lastId = after;
      try {
        while (!abortController.signal.aborted && !res.writableEnded) {
          const streams = await blockingRedisClient.xRead(
            { key: streamKey, id: lastId },
            { BLOCK: 10000, COUNT: 50 },
          );
          if (streams && streams.length) {
            for (const stream of streams) {
              for (const message of stream.messages) {
                const data = message.message.data;
                if (data && !res.writableEnded) {
                  let line = String(data);
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object') {
                      if (Array.isArray(parsed)) {
                        line = JSON.stringify({ id: message.id, data: parsed });
                      } else if (typeof (parsed as any).id !== 'string') {
                        (parsed as any).id = message.id;
                        line = JSON.stringify(parsed);
                      }
                    } else {
                      line = JSON.stringify({ id: message.id, data: parsed });
                    }
                  } catch {
                    // If the payload is not JSON (unexpected), stream it as-is.
                  }

                  res.write(`${line}\n`);
                  if (DEBUG_AGENT_RUN_STREAM) {
                    console.info('[agent-run-stream] sent', {
                      runId,
                      id: message.id,
                      bytes: line.length,
                      sample: line.slice(0, 160),
                    });
                  }
                }
                lastId = message.id;
              }
            }
          }
          if (!streams || !streams.length) {
            if (!res.writableEnded) {
              res.write('{"type":"keepalive"}\n');
            }
          }

          if (!terminalStatus) {
            const meta = await getRunMeta(runId);
            if (
              meta?.status === 'completed' ||
              meta?.status === 'failed' ||
              meta?.status === 'cancelled' ||
              meta?.status === 'awaiting_approval'
            ) {
              terminalStatus = meta.status;
            }
          }

          if (terminalStatus) {
            break;
          }
        }
      } catch (error) {
        if (!res.headersSent && !res.writableEnded) {
          res.status(500).json({ error: 'Run stream failed' });
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    void readLoop();
  });
}
