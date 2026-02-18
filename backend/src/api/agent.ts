import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { fetchAgentCatalog, runAgent, runAgentStream } from '../services/agentService';
import { WorkspaceService } from '../services/workspaceService';
import { FileService } from '../services/fileService';
import { HttpError } from '../errors';
import { personas as localPersonas } from '../config/personas';
import {
  buildPresentationHtmlPrompt,
  extractHtmlFromAgentResponse,
  renderFallbackPresentation,
} from '../services/presentationService';
import { Paper2SlidesService } from '../services/paper2SlidesService';
import { Paper2SlidesJobService } from '../services/paper2SlidesJobService';
import type { PresentationSourceFile } from '../types/presentation';
import {
  cancelAgentRun,
  getRunMeta,
  getRunStreamKey,
  resumeAgentRun,
  startAgentRun,
} from '../services/agentRunService';
import { blockingRedisClient } from '../services/redisService';
import { signAgentContextToken } from '../services/agentToken';

const DEFAULT_PRESENTATION_PERSONA = 'fast';
const IMAGE_NAME_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const extractTextFromAgentReply = (reply: unknown): string => {
  if (reply === null || reply === undefined) {
    return '';
  }
  if (typeof reply === 'string') {
    return reply;
  }
  if (Array.isArray(reply)) {
    return reply.map((item) => extractTextFromAgentReply(item)).join('\n');
  }
  if (typeof reply === 'object') {
    const payload = reply as Record<string, unknown>;
    if (typeof payload.content === 'string') {
      return payload.content;
    }
    if (Array.isArray(payload.content)) {
      return payload.content.map((item) => extractTextFromAgentReply(item)).join('');
    }
    if (typeof payload.text === 'string') {
      return payload.text;
    }
    if (Array.isArray(payload.messages)) {
      return payload.messages.map((item) => extractTextFromAgentReply(item)).join('\n');
    }
  }
  try {
    return JSON.stringify(reply);
  } catch {
    return String(reply);
  }
};

export default function(workspaceService: WorkspaceService, fileService: FileService) {
  const router = Router();
  const paper2SlidesService = new Paper2SlidesService(fileService);
  const paper2SlidesJobService = new Paper2SlidesJobService(fileService, workspaceService, paper2SlidesService);

  const runAgentSchema = z.object({
    persona: z.string().min(1),
    prompt: z.string().min(1),
    workspaceId: z.string().min(1),
    history: z.array(z.object({
      role: z.string().min(1),
      content: z.string().min(1),
    })).optional(),
    forceReset: z.boolean().optional(),
    turnId: z.string().optional(),
  });

  const presentationSchema = z.object({
    workspaceId: z.string().min(1),
    fileIds: z.array(z.number().int().positive()).min(1),
    brief: z.string().optional(),
    persona: z.string().min(1).optional(),
    output: z.enum(['slides', 'poster']).optional(),
    content: z.enum(['paper', 'general']).optional(),
    style: z.string().optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    mode: z.enum(['fast', 'normal']).optional(),
    parallel: z.union([z.number().int().positive(), z.boolean()]).optional(),
    fromStage: z.enum(['rag', 'analysis', 'summary', 'plan', 'generate']).optional(),
    exportPptx: z.boolean().optional(),
  });

  const pptxExportSchema = z.object({
    workspaceId: z.string().min(1),
    fileId: z.number().int().positive(),
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

  router.get('/personas', async (_req, res) => {
    try {
      const catalog = await fetchAgentCatalog();
      res.json(catalog.agents);
    } catch (error) {
      console.error("Failed to fetch agent catalog, falling back to local personas", error);
      res.json(
        localPersonas.map((persona) => ({
          name: persona.name,
          displayName: persona.displayName,
          description: persona.description,
        })),
      );
    }
  });

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  router.post('/paper2slides/jobs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const {
        workspaceId,
        fileIds,
        brief,
        persona,
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      } = presentationSchema.parse(req.body);

      const job = await paper2SlidesJobService.createJob({
        workspaceId,
        userId: user.userId,
        fileIds,
        brief,
        persona,
        options: {
          output,
          content,
          style,
          length,
          mode,
          parallel,
          fromStage,
          exportPptx,
        },
      });

      res.json({ jobId: job.id, status: job.status, createdAt: job.createdAt });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to start Paper2Slides job');
    }
  });

  router.get('/paper2slides/jobs/:jobId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { jobId } = req.params;
      const job = await paper2SlidesJobService.getJob(jobId, user.userId);
      res.json({
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error: any) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to fetch Paper2Slides job');
    }
  });

  router.post('/paper2slides/export-pptx', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { workspaceId, fileId } = pptxExportSchema.parse(req.body);
      const result = await paper2SlidesService.exportPptxFromPdf(workspaceId, user.userId, fileId);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to export PPTX');
    }
  });

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

  const injectTaggedFileUrls = async (prompt: string, workspaceId: string, userId: string) => {
    if (!prompt || !prompt.includes('@')) {
      return prompt;
    }
    const files = await fileService.getFiles(workspaceId, userId);
    const tagged = files.filter((file) => prompt.includes(`@${file.name}`));
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
      ? `\n\nTagged files (preferred for retrieval):\n${taggedPaths.map((path) => `- ${path}`).join('\n')}`
      : '';
    const urlList = withUrls
      .map((file) => `- ${file.name}: ${file.publicUrl}`)
      .join('\n');
    const urlHint = withUrls.length
      ? `\n\nTagged image URLs (use these HTTP links instead of file paths in HTML/Markdown/Mermaid):\n${urlList}`
      : '';
    return `${prompt}${fileHint}${urlHint}`;
  };

  router.post('/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      const policy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId);
      const authToken = signAgentContextToken({
        sub: user.userId,
        userId: user.userId,
        workspaceId,
        ...policy,
      });
      const response = await runAgent(persona, workspaceId, enrichedPrompt, history, { forceReset, authToken: authToken || undefined });
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
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      const policy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId);
      const authToken = signAgentContextToken({
        sub: user.userId,
        userId: user.userId,
        workspaceId,
        ...policy,
      });
      streamResponse = await runAgentStream(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        signal: upstreamAbort.signal,
        authToken: authToken || undefined,
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
        console.error("Agent stream error", error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Agent stream failed' });
        } else {
          if (!res.writableEnded) {
            res.end();
          }
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
      const { persona, prompt, workspaceId, history, forceReset, turnId } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const policy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId);
      const authToken = signAgentContextToken({
        sub: user.userId,
        userId: user.userId,
        workspaceId,
        ...policy,
      });
      const { runId, status } = await startAgentRun({
        persona,
        workspaceId,
        prompt: enrichedPrompt,
        history,
        forceReset,
        turnId,
        authToken: authToken || undefined,
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
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting approval' });
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
      const result = await resumeAgentRun(runId, decisions);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to submit run decision');
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

    // NDJSON/JSONL streaming over fetch() should not be buffered by proxies.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx-style hint (harmless elsewhere). Helps avoid proxy buffering that can make the UI look "stuck".
    res.setHeader('X-Accel-Buffering', 'no');
    // Send headers immediately so the browser starts streaming right away.
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
            { BLOCK: 10000, COUNT: 50 }
          );
          if (streams && streams.length) {
            for (const stream of streams) {
              for (const message of stream.messages) {
                const data = message.message.data;
                if (data && !res.writableEnded) {
                  // Attach the Redis stream entry id so clients can resume after transient disconnects.
                  // Keep backward compatibility by preserving the original payload shape.
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
          // Keep the connection active even during long tool calls (some networks/LBs time out idle streams).
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

          if (terminalStatus && (!streams || !streams.length)) {
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

  router.post('/presentation', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const {
        workspaceId,
        fileIds,
        brief,
        persona,
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      } = presentationSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });

      const files: PresentationSourceFile[] = [];
      const paper2SlidesFiles: Array<{ name: string; buffer: Buffer }> = [];
      for (const fileId of fileIds) {
        const file = await fileService.getFileContent(fileId, user.userId);
        if (file.workspaceId !== workspaceId) {
          throw new HttpError(400, 'One or more files do not belong to the selected workspace');
        }
        const mimeType = typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
        const isLikelyText =
          mimeType.startsWith('text/') ||
          mimeType === 'application/json' ||
          mimeType === 'text/markdown' ||
          mimeType === 'text/html' ||
          /\.md$/i.test(file.name) ||
          /\.txt$/i.test(file.name) ||
          /\.html?$/i.test(file.name) ||
          /\.json$/i.test(file.name);
        const contentStr = typeof file.content === 'string' ? file.content : '';
        const buffer = isLikelyText ? Buffer.from(contentStr, 'utf-8') : Buffer.from(contentStr, 'base64');
        paper2SlidesFiles.push({ name: file.name, buffer });

        if (isLikelyText) {
          files.push({
            id: file.id,
            name: file.name,
            path: file.path,
            content: contentStr,
          });
        }
      }

      // Attempt Paper2Slides pipeline first.
      const paper2SlidesOptions = {
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      };

      try {
        const paperOutputs = await paper2SlidesService.generate(
          workspaceId,
          user.userId,
          paper2SlidesFiles,
          paper2SlidesOptions,
        );
        res.json(paperOutputs);
        return;
      } catch (paperError: any) {
        console.warn('Paper2Slides pipeline failed, falling back to HTML agent:', paperError?.message || paperError);
      }

      if (!files.length) {
        throw new HttpError(400, 'Paper2Slides failed and no text-based files are available for fallback generation');
      }

      const prompt = buildPresentationHtmlPrompt({
        brief,
        files,
      });
      const agentResponse = await runAgent(
        persona || DEFAULT_PRESENTATION_PERSONA,
        workspaceId,
        prompt,
        undefined,
        { forceReset: true },
      );
      const rawReply = extractTextFromAgentReply((agentResponse && (agentResponse as any).reply) || agentResponse);
      if (!rawReply) {
        throw new HttpError(502, 'Agent returned an empty response');
      }
      let htmlContent: string;
      try {
        htmlContent = extractHtmlFromAgentResponse(rawReply);
      } catch (error) {
        console.warn('Presentation agent output invalid, falling back to markdown renderer', error);
        try {
          htmlContent = renderFallbackPresentation(files, brief);
        } catch (fallbackError) {
          throw new HttpError(
            502,
            'Agent returned invalid presentation HTML and fallback failed',
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          );
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const htmlName = `presentations/presentation-${timestamp}.html`;
      await fileService.createFile(
        workspaceId,
        htmlName,
        Buffer.from(htmlContent, 'utf-8'),
        'text/html',
        user.userId,
      );

      res.json({
        htmlPath: htmlName,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to generate presentation');
    }
  });

  return router;
}
