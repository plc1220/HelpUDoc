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
      const { workspaceId, fileIds, brief, persona } = presentationSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });

      const files: PresentationSourceFile[] = [];
      for (const fileId of fileIds) {
        const file = await fileService.getFileContent(fileId, user.userId);
        if (file.workspaceId !== workspaceId) {
          throw new HttpError(400, 'One or more files do not belong to the selected workspace');
        }
        if (typeof file.content !== 'string') {
          throw new HttpError(400, `File ${file.name} is not readable as text`);
        }
        files.push({
          id: file.id,
          name: file.name,
          path: file.path,
          content: file.content,
        });
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
