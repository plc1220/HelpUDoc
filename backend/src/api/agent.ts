import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { fetchAgentCatalog, runAgent, runAgentStream } from '../services/agentService';
import { WorkspaceService } from '../services/workspaceService';
import { HttpError } from '../errors';
import { personas as localPersonas } from '../config/personas';

export default function(workspaceService: WorkspaceService) {
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

  router.post('/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const response = await runAgent(persona, workspaceId, prompt, history, { forceReset });
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
      const streamResponse = await runAgentStream(persona, workspaceId, prompt, history, { forceReset });
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

  return router;
}
