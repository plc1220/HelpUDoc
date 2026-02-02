import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const agentConfigPath = path.join(repoRoot, 'agent', 'config', 'runtime.yaml');
const skillsRoot = path.join(repoRoot, 'skills');

type SkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
};

const updateConfigSchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

const createSkillSchema = z.object({
  id: z.string().min(1, 'Skill id is required'),
  name: z.string().optional(),
  description: z.string().optional(),
});

const updateSkillContentSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  content: z.string(),
});

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

const isValidSkillId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

function resolveSkillDir(id: string) {
  const normalizedId = id.trim();
  if (!isValidSkillId(normalizedId)) {
    throw new Error('Invalid skill id');
  }
  return path.join(skillsRoot, normalizedId);
}

function resolveSkillFile(id: string, relativePath: string) {
  const skillDir = resolveSkillDir(id);
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid path');
  }
  const resolved = path.resolve(skillDir, normalized);
  if (!resolved.startsWith(skillDir)) {
    throw new Error('Invalid path');
  }
  return resolved;
}

function extractFrontmatter(content: string) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  return match[1];
}

async function getSkillMetadata(skillId: string): Promise<SkillMetadata> {
  const skillDir = resolveSkillDir(skillId);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!await pathExists(skillFile)) {
    return {
      id: skillId,
      name: skillId,
      description: 'No SKILL.md found',
      valid: false,
      error: 'Missing SKILL.md',
    };
  }

  try {
    const content = await fs.readFile(skillFile, 'utf-8');
    const frontmatterRaw = extractFrontmatter(content);
    if (!frontmatterRaw) {
      return { id: skillId, name: skillId, valid: true, warning: 'No frontmatter' };
    }

    const frontmatter = parseYaml(frontmatterRaw) as { name?: string; description?: string } | null;
    return {
      id: skillId,
      name: frontmatter?.name?.toString() || skillId,
      description: frontmatter?.description?.toString() || '',
      valid: true,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to parse SKILL.md';
    return { id: skillId, name: skillId, valid: false, error: message };
  }
}

async function collectSkillFiles(dir: string, relativeDir = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let results: string[] = [];

  for (const entry of entries) {
    const relPath = path.join(relativeDir, entry.name);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await collectSkillFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push(relPath.replace(/\\/g, '/'));
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

export default function settingsRoutes() {
  const router = Router();

  router.get('/agent-config', async (_req, res) => {
    try {
      const content = await fs.readFile(agentConfigPath, 'utf-8');
      res.json({ content });
    } catch (error) {
      console.error('Failed to read runtime config', error);
      res.status(500).json({ error: 'Failed to read runtime config' });
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
      console.error('Failed to update runtime config', error);
      res.status(500).json({ error: 'Failed to update runtime config' });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      await fs.mkdir(skillsRoot, { recursive: true });
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      const skills: SkillMetadata[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        try {
          const metadata = await getSkillMetadata(entry.name);
          skills.push(metadata);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to read skill';
          skills.push({ id: entry.name, name: entry.name, valid: false, error: message });
        }
      }

      res.json({ skills });
    } catch (error) {
      console.error('Failed to load skills', error);
      res.status(500).json({ error: 'Failed to load skills' });
    }
  });

  router.post('/skills', async (req, res) => {
    try {
      const { id, name, description } = createSkillSchema.parse(req.body);
      await fs.mkdir(skillsRoot, { recursive: true });
      const skillDir = resolveSkillDir(id);

      if (await pathExists(skillDir)) {
        return res.status(409).json({ error: 'Skill already exists' });
      }

      await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'docs'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'examples'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'templates'), { recursive: true });

      const skillContent = `---
name: ${name || id}
description: ${description || ''}
---

# ${name || id}

(Description of the skill)

## Reference Files
- [Docs](./docs/)
- [Scripts](./scripts/)
- [Examples](./examples/)
- [Templates](./templates/)
`;

      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
      await fs.writeFile(path.join(skillDir, 'scripts', 'README.md'), '# Scripts\n\nPlace your helper scripts here.', 'utf-8');
      await fs.writeFile(path.join(skillDir, 'docs', 'README.md'), '# Documentation\n\nPlace your documentation files here.', 'utf-8');
      await fs.writeFile(path.join(skillDir, 'examples', 'README.md'), '# Examples\n\nPlace your example files here.', 'utf-8');
      await fs.writeFile(path.join(skillDir, 'templates', 'README.md'), '# Templates\n\nPlace your code templates here.', 'utf-8');

      res.json({ success: true, id });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      console.error('Failed to create skill', error);
      res.status(500).json({ error: 'Failed to create skill' });
    }
  });

  router.get('/skills/:id/files', async (req, res) => {
    try {
      const skillDir = resolveSkillDir(req.params.id);
      if (!await pathExists(skillDir)) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      const files = await collectSkillFiles(skillDir);
      res.json({ files });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load skill files';
      if (message === 'Invalid skill id') {
        return res.status(400).json({ error: message });
      }
      console.error('Failed to load skill files', error);
      res.status(500).json({ error: 'Failed to load skill files' });
    }
  });

  router.get('/skills/:id/content', async (req, res) => {
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath) {
      return res.status(400).json({ error: 'Path query required' });
    }

    try {
      const fullPath = resolveSkillFile(req.params.id, filePath);
      if (!await pathExists(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to read skill file';
      if (message === 'Invalid skill id' || message === 'Invalid path') {
        return res.status(400).json({ error: message });
      }
      console.error('Failed to read skill file', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  router.put('/skills/:id/content', async (req, res) => {
    try {
      const { path: filePath, content } = updateSkillContentSchema.parse(req.body);
      const fullPath = resolveSkillFile(req.params.id, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      res.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      const message = error instanceof Error ? error.message : 'Failed to update skill file';
      if (message === 'Invalid skill id' || message === 'Invalid path') {
        return res.status(400).json({ error: message });
      }
      console.error('Failed to update skill file', error);
      res.status(500).json({ error: 'Failed to update skill file' });
    }
  });

  return router;
}
