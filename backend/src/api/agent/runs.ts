import { Router, type Request, type Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { runAgent, runAgentStream, type AgentMessageContentBlock } from '../../services/agentService';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import type { GoogleOAuthService } from '../../services/googleOAuthService';
import type { UserService } from '../../services/userService';
import type { ConversationService } from '../../services/conversationService';
import { HttpError } from '../../errors';
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

const IMAGE_NAME_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
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
  currentTurnFileIds: z.array(z.number().int().positive()).optional(),
  internetSearchEnabled: z.boolean().optional(),
  fileContextRefs: z.array(z.object({
    sourceFileId: z.number().int().positive(),
    sourceName: z.string().min(1),
    sourceMimeType: z.string().nullable().optional(),
    sourceVersionFingerprint: z.string().min(1),
    artifactId: z.string().min(1),
    artifactVersion: z.number().int().positive(),
    derivedArtifactFileId: z.number().int().positive().nullable().optional(),
    derivedArtifactPath: z.string().nullable().optional(),
    effectiveMode: z.enum(['part', 'parser', 'hybrid']),
    status: z.enum(['pending', 'partial', 'ready', 'failed', 'superseded']),
    summary: z.string().nullable().optional(),
    lastError: z.string().nullable().optional(),
  }).strict()).optional(),
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
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
};

const isImageFile = (file: any): boolean => {
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
  if (mimeType.startsWith('image/')) {
    return true;
  }
  return IMAGE_NAME_PATTERN.test(String(file.name || ''));
};

const normalizeTaggedValue = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\/+/, '');

export function registerRunRoutes(
  router: Router,
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
  conversationService: ConversationService,
) {
  const policyApi = createAgentPolicyApi(googleOAuthService, userService);

  const injectTaggedFileUrls = async (
    prompt: string,
    workspaceId: string,
    userId: string,
    explicitTaggedFiles?: string[],
  ) => {
    const normalizedExplicit = Array.from(
      new Set((explicitTaggedFiles || []).map((value) => normalizeTaggedValue(String(value || ''))).filter(Boolean)),
    );
    if ((!prompt || !prompt.includes('@')) && !normalizedExplicit.length) {
      return prompt;
    }
    const files = await fileService.getFiles(workspaceId, userId);
    const explicitBasenames = new Set(normalizedExplicit.map((value) => path.posix.basename(value)));
    const tagged = files.filter((file) => {
      const fileName = typeof file.name === 'string' ? normalizeTaggedValue(file.name) : '';
      if (!fileName) {
        return false;
      }
      if (normalizedExplicit.length) {
        return normalizedExplicit.includes(fileName) || explicitBasenames.has(path.posix.basename(fileName));
      }
      return prompt.includes(`@${file.name}`);
    });
    const withUrls = tagged.filter((file) => file.publicUrl && isImageFile(file));
    const taggedPaths = Array.from(
      new Set(
        tagged
          .map((file) => (typeof file.name === 'string' ? file.name.trim() : ''))
          .filter((name) => name.length > 0),
      ),
    ).map((name) => (name.startsWith('/') ? name : `/${name}`));

    if (!withUrls.length && !taggedPaths.length) {
      return prompt;
    }
    const fileHint = taggedPaths.length
      ? `\n\nTagged files (preferred for retrieval):\n${taggedPaths.map((entry) => `- ${entry}`).join('\n')}`
      : '';
    const urlList = withUrls
      .map((file) => `- ${file.name}: ${file.publicUrl}`)
      .join('\n');
    const urlHint = withUrls.length
      ? `\n\nTagged image URLs (use these HTTP links instead of file paths in HTML/Markdown/Mermaid):\n${urlList}`
      : '';
    return `${prompt}${fileHint}${urlHint}`;
  };

  const buildCurrentTurnMessageContent = async (
    workspaceId: string,
    userId: string,
    prompt: string,
    currentTurnFileIds?: number[],
  ): Promise<AgentMessageContentBlock[] | undefined> => {
    const normalizedIds = Array.from(
      new Set(
        (currentTurnFileIds || [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );
    if (!normalizedIds.length) {
      return undefined;
    }

    const fileBlocks: AgentMessageContentBlock[] = [];

    for (const fileId of normalizedIds) {
      const file = await fileService.getFileContent(fileId, userId);
      const mimeType = typeof file.mimeType === 'string' && file.mimeType.trim()
        ? file.mimeType.trim()
        : 'application/octet-stream';
      const encoded = typeof file.content === 'string' ? file.content : '';
      if (!encoded) {
        continue;
      }
      const byteLength = Buffer.byteLength(encoded, 'base64');
      if (byteLength > CURRENT_TURN_MULTIMODAL_MAX_BYTES) {
        console.info('Skipping oversized current-turn multimodal attachment', {
          workspaceId,
          fileId,
          fileName: file.name,
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
          filename: String(file.name || `attachment-${fileId}.pdf`),
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
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, currentTurnFileIds, internetSearchEnabled, fileContextRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
      const response = await runAgent(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        authToken: authToken || undefined,
        fileContextRefs,
        messageContent,
        internetSearchEnabled,
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
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, currentTurnFileIds, internetSearchEnabled, fileContextRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
      streamResponse = await runAgentStream(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        signal: upstreamAbort.signal,
        authToken: authToken || undefined,
        fileContextRefs,
        messageContent,
        internetSearchEnabled,
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
        console.error('Agent stream error', error);
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
      const { persona, prompt, workspaceId, conversationId, history, forceReset, turnId, taggedFiles, currentTurnFileIds, internetSearchEnabled, fileContextRefs } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      if (conversationId) {
        await conversationService.ensureConversationAccess(user.userId, workspaceId, conversationId, { requireEdit: true });
      }
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
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
        fileContextRefs,
        messageContent,
        internetSearchEnabled,
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await policyApi.buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
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
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
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
