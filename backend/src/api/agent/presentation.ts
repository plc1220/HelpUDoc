import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WorkspaceService } from '../../services/workspaceService';
import type { FileService } from '../../services/fileService';
import type { Paper2SlidesService } from '../../services/paper2SlidesService';
import { runAgent } from '../../services/agentService';
import type { PresentationSourceFile } from '../../types/presentation';
import {
  buildPresentationHtmlPrompt,
  extractHtmlFromAgentResponse,
  renderFallbackPresentation,
} from '../../services/presentationService';
import { HttpError } from '../../errors';

const DEFAULT_PRESENTATION_PERSONA = 'fast';

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

export function registerPresentationRoutes(
  router: Router,
  workspaceService: WorkspaceService,
  fileService: FileService,
  paper2SlidesService: Paper2SlidesService,
) {
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
}
