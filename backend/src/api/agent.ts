import { Router } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/databaseService';

export default function(dbService: DatabaseService) {
  const router = Router();

  const runAgentSchema = z.object({
    persona: z.string().min(1),
    prompt: z.string().min(1),
  });

  router.post('/run', (req, res) => {
    try {
      runAgentSchema.parse(req.body);
      // TODO: Implement agent execution logic
      res.json({ response: 'Agent executed successfully' });
    } catch (error) {
      res.status(400).json({ error: 'Invalid input' });
    }
  });

  return router;
}