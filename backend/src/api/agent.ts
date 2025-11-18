import { Router } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/databaseService';
import { fetchAgentCatalog, runAgent, runAgentStream } from '../services/agentService';

export default function(dbService: DatabaseService) {
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
      console.error("Failed to fetch agent catalog", error);
      res.status(500).json({ error: 'Failed to fetch agent catalog' });
    }
  });

  router.post('/run', async (req, res) => {
    try {
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
      const response = await runAgent(persona, workspaceId, prompt, history, { forceReset });
      res.json(response);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      console.error("Failed to run agent", error?.message || error);
      res.status(500).json({ error: 'Failed to run agent' });
    }
  });

  router.post('/run-stream', async (req, res) => {
    try {
      const { persona, prompt, workspaceId, history, forceReset } = runAgentSchema.parse(req.body);
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
      console.error("Failed to stream agent response", error?.message || error);
      res.status(500).json({ error: 'Failed to stream agent response' });
    }
  });

  return router;
}
