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

const DEFAULT_PRESENTATION_PERSONA = 'general-assistant';
const IMAGE_NAME_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

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
    if (!withUrls.length) {
      return prompt;
    }
    const urlList = withUrls
      .map((file) => `- ${file.name}: ${file.publicUrl}`)
      .join('\n');
    return `${prompt}\n\nTagged image URLs (use these HTTP links instead of file paths in HTML/Markdown/Mermaid):\n${urlList}`;
  };

  router.post('/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId);
      const response = await runAgent(persona, workspaceId, enrichedPrompt, history, { forceReset });
      res.json(response);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to run agent');
    }
  });

  router.post('/run-stream', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId);
      const streamResponse = await runAgentStream(persona, workspaceId, enrichedPrompt, history, { forceReset });
      res.setHeader('Content-Type', 'application/jsonl');
      streamResponse.data.on('data', (chunk: Buffer) => {
        res.write(chunk);
      });
      streamResponse.data.on('end', () => {
        res.end();
      });
      streamResponse.data.on('error', (error: Error) => {
        console.error("Agent stream error", error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Agent stream failed' });
        } else {
          res.end();
        }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to stream agent response');
    }
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
