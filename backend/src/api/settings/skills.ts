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
import { getContextFilesForUser } from './skillBuilder';

const createSkillSchema = z.object({
  id: z.string().min(1, 'Skill id is required'),
  name: z.string().optional(),
  description: z.string().optional(),
});

const updateSkillContentSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  content: z.string(),
});

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

export async function scaffoldSkill(skillId: string, name?: string, description?: string) {
  const skillDir = resolveSkillDir(skillId);
  if (await pathExists(skillDir)) {
    throw new Error('Skill already exists');
  }

  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(skillDir, 'templates'), { recursive: true });

  const title = name || skillId;
  const desc = (description || '').trim();

  const skillContent = `---\nname: ${title}\ndescription: ${desc}\n---\n\n# ${title}\n\n## Overview\n\n${desc || '(Add skill overview)'}\n\n## Instructions\n\n1. Define the workflow\n2. Reference supporting files in this skill\n\n## Files\n\n- \`scripts/\` for executable helpers\n- \`references/\` for docs\n- \`assets/\` for images and static resources\n- \`templates/\` for reusable templates\n`;

  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
  await fs.writeFile(path.join(skillDir, 'scripts', 'README.md'), '# Scripts\n\nPlace helper Python scripts here.\n', 'utf-8');
  await fs.writeFile(path.join(skillDir, 'references', 'README.md'), '# References\n\nPlace reference docs here.\n', 'utf-8');
  await fs.writeFile(path.join(skillDir, 'assets', 'README.md'), '# Assets\n\nPlace images/assets here.\n', 'utf-8');
  await fs.writeFile(path.join(skillDir, 'templates', 'README.md'), '# Templates\n\nPlace templates here.\n', 'utf-8');
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

  router.post('/skills', async (req, res) => {
    try {
      const { id, name, description } = createSkillSchema.parse(req.body);
      await fs.mkdir(skillsRoot, { recursive: true });
      await scaffoldSkill(id, name, description);
      res.json({ success: true, id });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      const message = error instanceof Error ? error.message : 'Failed to create skill';
      const status = /already exists/i.test(message) ? 409 : 500;
      res.status(status).json({ error: message });
    }
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

  router.put(/^\/skills\/(.+)\/content$/, async (req, res) => {
    try {
      const { path: filePath, content } = updateSkillContentSchema.parse(req.body);
      const skillId = req.params[0];
      const fullPath = resolveSkillFile(skillId, filePath, IMPORT_ALLOWED_PREFIXES);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      res.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      const message = error instanceof Error ? error.message : 'Failed to update skill file';
      if (['Invalid skill id', 'Invalid path', 'Unsupported target path'].includes(message)) {
        return res.status(400).json({ error: message });
      }
      console.error('Failed to update skill file', error);
      res.status(500).json({ error: 'Failed to update skill file' });
    }
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

  router.post('/skills/apply-actions', async (req, res) => {
    try {
      const user = req.userContext;
      if (!user) {
        return res.status(401).json({ error: 'Missing user context' });
      }
      const { actions } = applyActionsSchema.parse(req.body);
      await fs.mkdir(skillsRoot, { recursive: true });

      const results: Array<{ index: number; type: string; status: 'ok' | 'error'; message?: string }> = [];
      const contextFiles = getContextFilesForUser(user.userId);

      for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i];
        try {
          if (action.type === 'create_skill') {
            await scaffoldSkill(action.skillId, action.name, action.description);
          } else if (action.type === 'upsert_text') {
            const fullPath = resolveSkillFile(action.skillId, action.path);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, action.content, 'utf-8');
          } else if (action.type === 'upload_binary_from_context') {
            const contextFile = contextFiles.find((item) => item.fileId === action.contextFileId);
            if (!contextFile) {
              throw new Error(`Context file not found: ${action.contextFileId}`);
            }
            const targetPath = resolveSkillFile(action.skillId, action.targetPath, IMPORT_ALLOWED_PREFIXES);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(contextFile.absolutePath, targetPath);
          } else if (action.type === 'delete_file') {
            const fullPath = resolveSkillFile(action.skillId, action.path, IMPORT_ALLOWED_PREFIXES);
            if (await pathExists(fullPath)) {
              await fs.rm(fullPath, { force: true });
            }
          }

          results.push({ index: i, type: action.type, status: 'ok' });
        } catch (error: any) {
          const message = error?.message || 'Failed to apply action';
          results.push({ index: i, type: action.type, status: 'error', message });
          return res.status(400).json({ success: false, results, error: message });
        }
      }

      return res.json({ success: true, results });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid payload' });
      }
      console.error('Failed to apply actions', error);
      return res.status(500).json({ error: 'Failed to apply actions' });
    }
  });
}
