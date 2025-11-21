import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';

const repoRoot = path.resolve(__dirname, '../../..');
const agentConfigPath = path.join(repoRoot, 'agent', 'config', 'agents.yaml');
const promptsRoot = path.join(repoRoot, 'agent', 'prompts');

type PromptFile = {
  id: string;
  label: string;
  content: string;
};

const updateConfigSchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

const updatePromptSchema = z.object({
  id: z.string().min(1, 'Prompt id is required'),
  content: z.string(),
});

const capitalize = (value: string) => {
  if (!value) {
    return value;
  }
  const normalized = value.replace(/[-_]+/g, ' ');
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
};

async function collectPromptFiles(dir: string): Promise<PromptFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const prompts: PromptFile[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      prompts.push(...await collectPromptFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const relativePath = path.relative(promptsRoot, fullPath).replace(/\\/g, '/');
    const id = relativePath.replace(/\.md$/, '');
    const segments = id.split('/');
    const label = segments.map(capitalize).join(' / ');
    const content = await fs.readFile(fullPath, 'utf-8');
    prompts.push({ id, label, content });
  }

  return prompts.sort((a, b) => a.id.localeCompare(b.id));
}

function promptIdToPath(id: string) {
  const normalizedId = id.replace(/\\/g, '/');
  const rawPath = path.join(promptsRoot, ...normalizedId.split('/')) + '.md';
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(promptsRoot)) {
    throw new Error('Invalid prompt id');
  }
  return resolved;
}

export default function settingsRoutes() {
  const router = Router();

  router.get('/agent-config', async (_req, res) => {
    try {
      const content = await fs.readFile(agentConfigPath, 'utf-8');
      res.json({ content });
    } catch (error) {
      console.error('Failed to read agent config', error);
      res.status(500).json({ error: 'Failed to read agent config' });
    }
  });

  router.put('/agent-config', async (req, res) => {
    try {
      const { content } = updateConfigSchema.parse(req.body);
      await fs.writeFile(agentConfigPath, content, 'utf-8');
      res.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      console.error('Failed to update agent config', error);
      res.status(500).json({ error: 'Failed to update agent config' });
    }
  });

  router.get('/prompts', async (_req, res) => {
    try {
      const prompts = await collectPromptFiles(promptsRoot);
      res.json({ prompts });
    } catch (error) {
      console.error('Failed to load prompts', error);
      res.status(500).json({ error: 'Failed to load prompts' });
    }
  });

  router.put('/prompts', async (req, res) => {
    try {
      const { id, content } = updatePromptSchema.parse(req.body);
      const promptPath = promptIdToPath(id);
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      await fs.writeFile(promptPath, content, 'utf-8');
      res.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      console.error('Failed to update prompt', error);
      res.status(500).json({ error: 'Failed to update prompt' });
    }
  });

  return router;
}
