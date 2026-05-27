import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { skillsRoot } from '../../services/skills/constants';
import { collectSkillIds, pathExists } from '../../services/skills/registry';
import {
  IMPORT_ALLOWED_PREFIXES,
  resolveSkillDir,
  resolveSkillFile,
} from '../../services/skills/paths';
import { getSkillMetadata, type SkillMetadata } from '../../services/skills/metadata';

const skillsReadOnlyResponse = (res: import('express').Response) =>
  res.status(405).json({ error: 'Skills are managed by CI/CD and are read-only at runtime.' });

const createSkillActionSchema = z.object({
  type: z.literal('create_skill'),
  skillId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  template: z.string().optional(),
});

const upsertTextActionSchema = z.object({
  type: z.literal('upsert_text'),
  skillId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal('utf-8').default('utf-8'),
});

const uploadBinaryFromContextActionSchema = z.object({
  type: z.literal('upload_binary_from_context'),
  skillId: z.string().min(1),
  contextFileId: z.string().min(1),
  targetPath: z.string().min(1),
});

const deleteFileActionSchema = z.object({
  type: z.literal('delete_file'),
  skillId: z.string().min(1),
  path: z.string().min(1),
});

const applyActionsSchema = z.object({
  actions: z.array(z.discriminatedUnion('type', [
    createSkillActionSchema,
    upsertTextActionSchema,
    uploadBinaryFromContextActionSchema,
    deleteFileActionSchema,
  ])).min(1),
});

const parseActionsSchema = z.object({
  text: z.string().min(1),
});

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

function extractActionsFromText(text: string): unknown[] {
  const blockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = (blockMatch ? blockMatch[1] : text).trim();
  if (!candidate) return [];
  const parsed = JSON.parse(candidate);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).actions)) {
    return (parsed as any).actions;
  }
  throw new Error('No actions array found in input text');
}

export function registerSkillsRoutes(router: Router) {
  router.get('/skills', async (_req, res) => {
    try {
      await fs.mkdir(skillsRoot, { recursive: true });
      const skillIds = await collectSkillIds(skillsRoot);
      const skills: SkillMetadata[] = [];

      for (const skillId of skillIds) {
        try {
          const metadata = await getSkillMetadata(skillId);
          skills.push(metadata);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to read skill';
          skills.push({ id: skillId, name: skillId, valid: false, error: message });
        }
      }

      res.json({ skills });
    } catch (error) {
      console.error('Failed to load skills', error);
      res.status(500).json({ error: 'Failed to load skills' });
    }
  });

  router.post('/skills', (_req, res) => {
    return skillsReadOnlyResponse(res);
  });

  router.get(/^\/skills\/(.+)\/files$/, async (req, res) => {
    try {
      const skillId = req.params[0];
      const skillDir = resolveSkillDir(skillId);
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

  router.get(/^\/skills\/(.+)\/content$/, async (req, res) => {
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath) {
      return res.status(400).json({ error: 'Path query required' });
    }

    try {
      const skillId = req.params[0];
      const fullPath = resolveSkillFile(skillId, filePath, IMPORT_ALLOWED_PREFIXES);
      if (!await pathExists(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to read skill file';
      if (['Invalid skill id', 'Invalid path', 'Unsupported target path'].includes(message)) {
        return res.status(400).json({ error: message });
      }
      console.error('Failed to read skill file', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  router.put(/^\/skills\/(.+)\/content$/, (_req, res) => {
    return skillsReadOnlyResponse(res);
  });

  router.post('/skills/parse-actions', async (req, res) => {
    try {
      const { text } = parseActionsSchema.parse(req.body);
      const rawActions = extractActionsFromText(text);
      const parsed = applyActionsSchema.parse({ actions: rawActions });
      res.json({ actions: parsed.actions });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid action payload' });
      }
      return res.status(400).json({ error: error?.message || 'Failed to parse actions' });
    }
  });

  router.post('/skills/apply-actions', (_req, res) => {
    return skillsReadOnlyResponse(res);
  });
}
