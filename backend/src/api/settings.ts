import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { existsSync } from 'fs';
import type { WorkspaceService } from '../services/workspaceService';
import type { DatabaseService } from '../services/databaseService';
import type { UserService } from '../services/userService';
import { buildWorkspaceOverview } from '../services/workspaceOverviewService';
import { fetchLangfuseAggregates } from '../services/langfuseClient';
import { collectSkillIds } from '../lib/skillsRegistry';
import { HttpError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';
import {
  cancelAgentRun,
  getRunMeta,
  getRunStreamKey,
  resumeAgentRun,
  startAgentRun,
} from '../services/agentRunService';
import { blockingRedisClient } from '../services/redisService';
import { signAgentContextToken } from '../services/agentToken';

const repoRoot = path.resolve(__dirname, '../../..');
const workspaceRoot = resolveWorkspaceRoot();
const resolveRepoRelativePath = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
};

// In production containers, the repo layout does not exist. Use explicit env vars.
// In local dev, fall back to the checked-in agent config so the Settings UI reflects
// the same runtime.yaml the Python agent actually loads.
const defaultAgentConfigDir = existsSync('/agent/config')
  ? '/agent/config'
  : path.join(repoRoot, 'agent', 'config');
const agentConfigPath = resolveRepoRelativePath(process.env.AGENT_CONFIG_PATH)
  || path.join(resolveRepoRelativePath(process.env.AGENT_CONFIG_DIR) || defaultAgentConfigDir, 'runtime.yaml');
const repoAgentConfigPath = path.join(repoRoot, 'agent', 'config', 'runtime.yaml');
const skillsRoot = process.env.SKILLS_ROOT || path.join(repoRoot, 'skills');

const skillBuilderStorageRoot = path.join(repoRoot, '.local-run', 'skill-builder');
const contextFilesRoot = path.join(skillBuilderStorageRoot, 'context-files');

const ENABLE_SKILL_BUILDER_ASSISTANT = String(process.env.ENABLE_SKILL_BUILDER_ASSISTANT ?? 'true').toLowerCase() !== 'false';
const ENABLE_GITHUB_SKILL_IMPORTER = String(process.env.ENABLE_GITHUB_SKILL_IMPORTER ?? 'true').toLowerCase() !== 'false';
const ENABLE_SKILL_SCRIPT_RUNNER = String(process.env.ENABLE_SKILL_SCRIPT_RUNNER ?? 'false').toLowerCase() === 'true';

const CONTEXT_ALLOWED_EXTENSIONS = [
  '.py', '.md', '.txt', '.pdf', '.csv', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
];
const CONTEXT_MAX_FILE_SIZE = 20 * 1024 * 1024;

const ACTION_ALLOWED_PREFIXES = ['SKILL.md', 'scripts/', 'references/', 'assets/', 'templates/'];
const IMPORT_ALLOWED_PREFIXES = ['SKILL.md', 'scripts/', 'references/', 'assets/', 'templates/', 'docs/', 'examples/'];
const IMPORT_BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com']);

const SKILL_BUILDER_PERSONA = 'skill-builder';

type SkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
};

type ContextFileMeta = {
  fileId: string;
  userId: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

type GithubImportFile = {
  path: string;
  size: number;
  content: Buffer;
};

type GithubInspectSession = {
  importSessionId: string;
  userId: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
    url: string;
  };
  detectedSkillId: string;
  files: GithubImportFile[];
  warnings: string[];
  createdAt: string;
};

const skillBuilderWorkspaceByUser = new Map<string, string>();
const contextFilesByUser = new Map<string, ContextFileMeta[]>();
const githubImportSessions = new Map<string, GithubInspectSession>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CONTEXT_MAX_FILE_SIZE,
    files: 1,
  },
});

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

const skillBuilderRunSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  history: z.array(
    z.object({
      role: z.string().min(1),
      content: z.string().min(1),
    }),
  ).optional(),
  contextFileIds: z.array(z.string().min(1)).optional(),
  selectedSkillId: z.string().optional(),
  turnId: z.string().optional(),
  forceReset: z.boolean().optional(),
});

const runDecisionSchema = z.object({
  decision: z.enum(['approve', 'edit', 'reject']),
  editedAction: z
    .object({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  message: z.string().optional(),
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

const githubInspectSchema = z.object({
  url: z.string().url(),
  ref: z.string().optional(),
  githubToken: z.string().optional(),
});

const githubApplySchema = z.object({
  importSessionId: z.string().min(1),
  destinationSkillId: z.string().optional(),
  onCollision: z.literal('copy').default('copy'),
});

const parseActionsSchema = z.object({
  text: z.string().min(1),
});

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

type RuntimeConfigShape = {
  tools?: Array<Record<string, unknown>>;
  mcp_servers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function mergeNamedEntries(
  baseEntries: unknown,
  overrideEntries: unknown,
): Array<Record<string, unknown>> | undefined {
  const base = Array.isArray(baseEntries) ? baseEntries : [];
  const override = Array.isArray(overrideEntries) ? overrideEntries : [];
  const merged = new Map<string, Record<string, unknown>>();

  for (const entry of base) {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).name !== 'string') continue;
    merged.set((entry as any).name, { ...(entry as Record<string, unknown>) });
  }
  for (const entry of override) {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).name !== 'string') continue;
    const name = (entry as any).name;
    merged.set(name, { ...(merged.get(name) || {}), ...(entry as Record<string, unknown>) });
  }

  return merged.size ? Array.from(merged.values()) : undefined;
}

function mergeRuntimeConfigs(
  baseConfig: RuntimeConfigShape,
  overrideConfig: RuntimeConfigShape,
): RuntimeConfigShape {
  const merged: RuntimeConfigShape = { ...baseConfig, ...overrideConfig };
  const mergedTools = mergeNamedEntries(baseConfig.tools, overrideConfig.tools);
  const mergedMcpServers = mergeNamedEntries(baseConfig.mcp_servers, overrideConfig.mcp_servers);
  if (mergedTools) merged.tools = mergedTools;
  if (mergedMcpServers) merged.mcp_servers = mergedMcpServers;
  return merged;
}

async function loadEffectiveAgentConfig(): Promise<{ content: string; changed: boolean }> {
  const baseContent = await fs.readFile(repoAgentConfigPath, 'utf-8');
  const baseParsed = (parseYaml(baseContent) as RuntimeConfigShape | null) || {};

  try {
    const liveContent = await fs.readFile(agentConfigPath, 'utf-8');
    const liveParsed = (parseYaml(liveContent) as RuntimeConfigShape | null) || {};
    const mergedParsed = mergeRuntimeConfigs(baseParsed, liveParsed);
    const mergedContent = stringifyYaml(mergedParsed);
    return { content: mergedContent, changed: mergedContent.trim() !== liveContent.trim() };
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') {
      return { content: stringifyYaml(baseParsed), changed: true };
    }
    throw error;
  }
}

const isValidSkillId = (id: string) => /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(id);

const normalizeSkillId = (id: string) => id.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function resolveSkillDir(id: string) {
  const normalizedId = normalizeSkillId(id);
  if (!isValidSkillId(normalizedId)) {
    throw new Error('Invalid skill id');
  }
  return path.join(skillsRoot, normalizedId);
}

function isAllowedActionPath(relativePath: string, prefixes = ACTION_ALLOWED_PREFIXES): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized === 'SKILL.md') return true;
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function resolveSkillFile(id: string, relativePath: string, prefixes = ACTION_ALLOWED_PREFIXES) {
  const skillDir = resolveSkillDir(id);
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error('Invalid path');
  }
  if (!isAllowedActionPath(normalized, prefixes)) {
    throw new Error('Unsupported target path');
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

function requireUserContext(req: Request) {
  if (!req.userContext) {
    throw new HttpError(401, 'Missing user context');
  }
  return req.userContext;
}

function handleError(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message, details: error.details });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
}

async function scaffoldSkill(skillId: string, name?: string, description?: string) {
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

async function ensureSkillBuilderWorkspace(user: { userId: string; displayName: string }): Promise<string> {
  const cached = skillBuilderWorkspaceByUser.get(user.userId);
  if (cached) {
    return cached;
  }

  const workspaceId = `skill-builder-${user.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const workspacePath = path.join(workspaceRoot, workspaceId);
  await fs.mkdir(workspacePath, { recursive: true });
  skillBuilderWorkspaceByUser.set(user.userId, workspaceId);
  return workspaceId;
}

function getContextFilesForUser(userId: string): ContextFileMeta[] {
  return contextFilesByUser.get(userId) || [];
}

function setContextFilesForUser(userId: string, files: ContextFileMeta[]) {
  contextFilesByUser.set(userId, files);
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (['.md', '.txt', '.py', '.json', '.yaml', '.yml', '.csv'].includes(ext)) {
    return 'text/plain';
  }
  if (ext === '.pdf') return 'application/pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
    return `image/${ext.replace('.', '').replace('jpg', 'jpeg')}`;
  }
  return 'application/octet-stream';
}

function parseGitHubSource(rawUrl: string, refOverride?: string) {
  const parsed = new URL(rawUrl);
  if (parsed.hostname !== 'github.com') {
    throw new Error('Only github.com URLs are supported in v1');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error('Invalid GitHub URL');
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');

  let ref = refOverride?.trim() || '';
  let dirPath = '';

  if (segments[2] === 'tree' && segments.length >= 4) {
    ref = ref || segments[3];
    dirPath = segments.slice(4).join('/');
  } else if (segments[2] === 'blob' && segments.length >= 5) {
    ref = ref || segments[3];
    dirPath = segments.slice(4, -1).join('/');
  } else {
    dirPath = segments.slice(2).join('/');
  }

  if (!ref) {
    ref = 'main';
  }

  return {
    owner,
    repo,
    ref,
    path: dirPath,
    url: rawUrl,
  };
}

async function githubApiJson(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'helpudoc-skill-importer',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub API error (${response.status}): ${text || response.statusText}`);
  }
  return response.json();
}

async function githubDownloadFile(url: string, token?: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    'User-Agent': 'helpudoc-skill-importer',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed downloading file (${response.status})`);
  }
  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

async function fetchGitHubDirectoryFiles(source: { owner: string; repo: string; ref: string; path: string }, token?: string) {
  const collected: GithubImportFile[] = [];
  const warnings: string[] = [];

  const walk = async (dirPath: string) => {
    const normalizedDirPath = dirPath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const endpoint = normalizedDirPath
      ? `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${normalizedDirPath}?ref=${encodeURIComponent(source.ref)}`
      : `https://api.github.com/repos/${source.owner}/${source.repo}/contents?ref=${encodeURIComponent(source.ref)}`;
    const payload = await githubApiJson(endpoint, token);
    const entries = Array.isArray(payload) ? payload : [payload];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'dir') {
        await walk(entry.path);
        continue;
      }
      if (entry.type !== 'file') continue;
      const ext = path.extname(String(entry.name || '')).toLowerCase();
      if (IMPORT_BLOCKED_EXTENSIONS.has(ext)) {
        warnings.push(`Skipped blocked file extension: ${entry.path}`);
        continue;
      }
      const downloadUrl = typeof entry.download_url === 'string' ? entry.download_url : '';
      if (!downloadUrl) {
        warnings.push(`Skipped file without download URL: ${entry.path}`);
        continue;
      }
      const content = await githubDownloadFile(downloadUrl, token);
      collected.push({
        path: String(entry.path || ''),
        size: Number(entry.size || content.length),
        content,
      });
    }
  };

  await walk(source.path || '');
  return { files: collected, warnings };
}

function toSkillRelativePath(sourceRoot: string, filePath: string): string {
  const normalizedRoot = sourceRoot.replace(/^\/+|\/+$/g, '');
  const normalizedPath = filePath.replace(/^\/+/, '');
  if (!normalizedRoot) return normalizedPath;
  if (!normalizedPath.startsWith(normalizedRoot)) return normalizedPath;
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '');
}

function resolveCollisionSkillId(baseSkillId: string): string {
  const candidateA = `${baseSkillId}-copy`;
  if (!isValidSkillId(baseSkillId)) {
    throw new Error('Invalid destination skill id');
  }
  const dirA = path.join(skillsRoot, candidateA);
  if (!existsSync(dirA)) {
    return candidateA;
  }
  let n = 2;
  while (true) {
    const candidate = `${baseSkillId}-v${n}`;
    const dir = path.join(skillsRoot, candidate);
    if (!existsSync(dir)) {
      return candidate;
    }
    n += 1;
  }
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

export default function settingsRoutes(
  _workspaceService: WorkspaceService,
  userService: UserService,
  databaseService: DatabaseService,
) {
  const router = Router();

  router.get('/workspace-overview', async (_req, res) => {
    try {
      const body = await buildWorkspaceOverview({
        db: databaseService.getDb(),
        userService,
        skillsRoot,
        nodeEnv: process.env.NODE_ENV,
        fetchLangfuse: fetchLangfuseAggregates,
        now: () => Date.now(),
      });
      res.json(body);
    } catch (error) {
      console.error('Failed to load workspace overview', error);
      res.status(500).json({ error: 'Failed to load workspace overview' });
    }
  });

  router.get('/agent-config', async (_req, res) => {
    try {
      await fs.mkdir(path.dirname(agentConfigPath), { recursive: true });
      const { content, changed } = await loadEffectiveAgentConfig();
      if (changed) {
        await fs.writeFile(agentConfigPath, content, 'utf-8');
      }
      res.json({ content });
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') {
        return res.json({ content: '' });
      }
      console.error('Failed to read runtime config', error);
      res.status(500).json({ error: 'Failed to read runtime config' });
    }
  });

  router.put('/agent-config', async (req, res) => {
    try {
      const { content } = updateConfigSchema.parse(req.body);
      await fs.mkdir(path.dirname(agentConfigPath), { recursive: true });
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
      const user = requireUserContext(req);
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
      return handleError(res, error, 'Failed to apply actions');
    }
  });

  router.post('/skills/import/github/inspect', async (req, res) => {
    if (!ENABLE_GITHUB_SKILL_IMPORTER) {
      return res.status(404).json({ error: 'GitHub skill importer is disabled' });
    }
    try {
      const user = requireUserContext(req);
      const { url, ref, githubToken } = githubInspectSchema.parse(req.body);
      const source = parseGitHubSource(url, ref);
      const { files, warnings } = await fetchGitHubDirectoryFiles(source, githubToken);
      if (!files.length) {
        return res.status(400).json({ error: 'No files found at source path' });
      }

      const relativeFiles = files.map((file) => ({
        ...file,
        skillPath: toSkillRelativePath(source.path, file.path),
      }));

      const hasSkill = relativeFiles.some((file) => file.skillPath === 'SKILL.md');
      if (!hasSkill) {
        return res.status(400).json({ error: 'Imported folder must include SKILL.md' });
      }

      const detectedSkillId = (source.path.split('/').filter(Boolean).pop() || source.repo)
        .replace(/[^a-zA-Z0-9_-]/g, '-');

      const importSessionId = crypto.randomUUID();
      const session: GithubInspectSession = {
        importSessionId,
        userId: user.userId,
        source,
        detectedSkillId,
        files: relativeFiles.map((file) => ({
          path: file.skillPath,
          size: file.size,
          content: file.content,
        })),
        warnings,
        createdAt: new Date().toISOString(),
      };
      githubImportSessions.set(importSessionId, session);

      res.json({
        importSessionId,
        source,
        detectedSkillId,
        filesPreview: session.files.map((file) => ({ path: file.path, size: file.size })),
        warnings,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid payload' });
      }
      return res.status(400).json({ error: error?.message || 'Failed to inspect GitHub import source' });
    }
  });

  router.post('/skills/import/github/apply', async (req, res) => {
    if (!ENABLE_GITHUB_SKILL_IMPORTER) {
      return res.status(404).json({ error: 'GitHub skill importer is disabled' });
    }
    try {
      const user = requireUserContext(req);
      const { importSessionId, destinationSkillId, onCollision } = githubApplySchema.parse(req.body);
      const session = githubImportSessions.get(importSessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Import session not found' });
      }

      const requested = (destinationSkillId || session.detectedSkillId).trim();
      if (!isValidSkillId(requested)) {
        return res.status(400).json({ error: 'Invalid destination skill id' });
      }

      let targetSkillId = requested;
      const targetDir = resolveSkillDir(targetSkillId);
      if (await pathExists(targetDir)) {
        if (onCollision !== 'copy') {
          return res.status(400).json({ error: 'Only copy collision strategy is supported in v1' });
        }
        targetSkillId = resolveCollisionSkillId(requested);
      }

      await scaffoldSkill(targetSkillId, targetSkillId, `Imported from ${session.source.url}`);

      const warnings = [...session.warnings];
      let filesImported = 0;
      for (const file of session.files) {
        if (!isAllowedActionPath(file.path, IMPORT_ALLOWED_PREFIXES)) {
          warnings.push(`Skipped unsupported path: ${file.path}`);
          continue;
        }
        const fullPath = resolveSkillFile(targetSkillId, file.path, IMPORT_ALLOWED_PREFIXES);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content);
        filesImported += 1;
      }

      githubImportSessions.delete(importSessionId);

      res.json({ importedSkillId: targetSkillId, filesImported, warnings });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid payload' });
      }
      return handleError(res, error, 'Failed to apply GitHub import');
    }
  });

  router.post('/skill-builder/session', async (req, res) => {
    if (!ENABLE_SKILL_BUILDER_ASSISTANT) {
      return res.status(404).json({ error: 'Skill Builder assistant is disabled' });
    }
    try {
      const user = requireUserContext(req);
      const workspaceId = await ensureSkillBuilderWorkspace(user);
      res.json({
        workspaceId,
        limits: {
          maxFileSize: CONTEXT_MAX_FILE_SIZE,
          maxFiles: 50,
        },
        allowedExtensions: CONTEXT_ALLOWED_EXTENSIONS,
      });
    } catch (error) {
      return handleError(res, error, 'Failed to create skill builder session');
    }
  });

  router.get('/skill-builder/context-files', async (req, res) => {
    try {
      const user = requireUserContext(req);
      res.json({ files: getContextFilesForUser(user.userId).map(({ absolutePath: _abs, userId: _uid, ...rest }) => rest) });
    } catch (error) {
      return handleError(res, error, 'Failed to load context files');
    }
  });

  router.post('/skill-builder/context-files', upload.single('file'), async (req, res) => {
    if (!ENABLE_SKILL_BUILDER_ASSISTANT) {
      return res.status(404).json({ error: 'Skill Builder assistant is disabled' });
    }
    try {
      const user = requireUserContext(req);
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const originalName = req.file.originalname || 'upload.bin';
      const ext = path.extname(originalName).toLowerCase();
      if (!CONTEXT_ALLOWED_EXTENSIONS.includes(ext)) {
        return res.status(400).json({ error: `Unsupported file extension: ${ext || '(none)'}` });
      }

      await fs.mkdir(path.join(contextFilesRoot, user.userId), { recursive: true });
      const fileId = crypto.randomUUID();
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const relativePath = `${user.userId}/${fileId}-${safeName}`;
      const absolutePath = path.join(contextFilesRoot, relativePath);
      await fs.writeFile(absolutePath, req.file.buffer);

      const meta: ContextFileMeta = {
        fileId,
        userId: user.userId,
        name: safeName,
        relativePath,
        absolutePath,
        size: req.file.size,
        mimeType: req.file.mimetype || guessMimeType(safeName),
        uploadedAt: new Date().toISOString(),
      };

      const existing = getContextFilesForUser(user.userId);
      existing.push(meta);
      setContextFilesForUser(user.userId, existing);

      res.json({
        fileId: meta.fileId,
        name: meta.name,
        relativePath: meta.relativePath,
        size: meta.size,
        mimeType: meta.mimeType,
      });
    } catch (error) {
      return handleError(res, error, 'Failed to upload context file');
    }
  });

  router.delete('/skill-builder/context-files/:fileId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const files = getContextFilesForUser(user.userId);
      const idx = files.findIndex((f) => f.fileId === req.params.fileId);
      if (idx < 0) {
        return res.status(404).json({ error: 'Context file not found' });
      }
      const [meta] = files.splice(idx, 1);
      setContextFilesForUser(user.userId, files);
      if (meta?.absolutePath && await pathExists(meta.absolutePath)) {
        await fs.rm(meta.absolutePath, { force: true });
      }
      res.json({ success: true });
    } catch (error) {
      return handleError(res, error, 'Failed to delete context file');
    }
  });

  router.post('/skill-builder/runs', async (req, res) => {
    if (!ENABLE_SKILL_BUILDER_ASSISTANT) {
      return res.status(404).json({ error: 'Skill Builder assistant is disabled' });
    }
    try {
      const user = requireUserContext(req);
      const payload = skillBuilderRunSchema.parse(req.body);
      const workspaceId = await ensureSkillBuilderWorkspace(user);

      const contextFiles = getContextFilesForUser(user.userId)
        .filter((file) => !payload.contextFileIds?.length || payload.contextFileIds.includes(file.fileId));

      if (contextFiles.length) {
        const workspaceContextDir = path.join(workspaceRoot, workspaceId, 'context');
        await fs.mkdir(workspaceContextDir, { recursive: true });
        for (const file of contextFiles) {
          const target = path.join(workspaceContextDir, file.name);
          await fs.copyFile(file.absolutePath, target);
        }
      }

      const contextLines: string[] = [];
      if (payload.selectedSkillId) {
        contextLines.push(`Selected skill target: ${payload.selectedSkillId}`);
      }
      if (contextFiles.length) {
        contextLines.push('Attached context files (available in workspace /context):');
        for (const file of contextFiles) {
          contextLines.push(`- /context/${file.name}`);
        }
      }

      const prompt = contextLines.length
        ? `${payload.prompt}\n\n${contextLines.join('\n')}`
        : payload.prompt;

      let authToken: string | undefined;
      if (ENABLE_SKILL_SCRIPT_RUNNER) {
        const token = signAgentContextToken({
          sub: user.userId,
          userId: user.userId,
          workspaceId,
          isAdmin: true,
          mcpServerAllowIds: [],
          mcpServerDenyIds: [],
          allowScriptRunner: true,
        });
        if (token) {
          authToken = token;
        }
      }

      const { runId, status } = await startAgentRun({
        workspaceId,
        persona: SKILL_BUILDER_PERSONA,
        prompt,
        history: payload.history,
        forceReset: payload.forceReset,
        turnId: payload.turnId,
        authToken,
      });

      res.json({ runId, status, workspaceId, persona: SKILL_BUILDER_PERSONA });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      return handleError(res, error, 'Failed to start Skill Builder run');
    }
  });

  router.get('/skill-builder/runs/:runId', async (req, res) => {
    try {
      requireUserContext(req);
      const meta = await getRunMeta(req.params.runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      res.json(meta);
    } catch (error) {
      return handleError(res, error, 'Failed to fetch run status');
    }
  });

  router.post('/skill-builder/runs/:runId/cancel', async (req, res) => {
    try {
      requireUserContext(req);
      await cancelAgentRun(req.params.runId);
      res.json({ status: 'cancelled' });
    } catch (error) {
      return handleError(res, error, 'Failed to cancel run');
    }
  });

  router.post('/skill-builder/runs/:runId/decision', async (req, res) => {
    try {
      requireUserContext(req);
      const payload = runDecisionSchema.parse(req.body);
      const decisions = [
        payload.decision === 'edit'
          ? {
              type: 'edit' as const,
              edited_action: {
                name: payload.editedAction?.name || 'request_plan_approval',
                args: payload.editedAction?.args || {},
              },
              message: payload.message,
            }
          : payload.decision === 'reject'
            ? { type: 'reject' as const, message: payload.message || 'Rejected by user' }
            : { type: 'approve' as const },
      ];
      const result = await resumeAgentRun(req.params.runId, decisions);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues?.[0]?.message || 'Invalid input' });
      }
      return handleError(res, error, 'Failed to submit run decision');
    }
  });

  router.get('/skill-builder/runs/:runId/stream', async (req, res) => {
    const { runId } = req.params;
    const after = typeof req.query.after === 'string' && req.query.after.trim() ? req.query.after : '0-0';
    const abortController = new AbortController();

    let streamKey: string | null = null;
    let terminalStatus: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | null = null;

    try {
      requireUserContext(req);
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      streamKey = getRunStreamKey(runId);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return handleError(res, error, 'Failed to authorize run stream');
    }

    const cleanup = () => {
      abortController.abort();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as any).flushHeaders?.();

    const readLoop = async () => {
      if (!streamKey) return;
      let lastId = after;
      try {
        while (!abortController.signal.aborted && !res.writableEnded) {
          const streams = await blockingRedisClient.xRead(
            { key: streamKey, id: lastId },
            { BLOCK: 10000, COUNT: 50 },
          );
          if (streams && streams.length) {
            for (const stream of streams) {
              for (const message of stream.messages) {
                const data = message.message.data;
                if (data && !res.writableEnded) {
                  let line = String(data);
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object') {
                      if (Array.isArray(parsed)) {
                        line = JSON.stringify({ id: message.id, data: parsed });
                      } else if (typeof (parsed as any).id !== 'string') {
                        (parsed as any).id = message.id;
                        line = JSON.stringify(parsed);
                      }
                    } else {
                      line = JSON.stringify({ id: message.id, data: parsed });
                    }
                  } catch {
                    // no-op
                  }

                  res.write(`${line}\n`);
                }
                lastId = message.id;
              }
            }
          }

          if (!streams || !streams.length) {
            if (!res.writableEnded) {
              res.write('{"type":"keepalive"}\n');
            }
          }

          const meta = await getRunMeta(runId);
          const status = meta?.status;
          if (status && ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(status)) {
            terminalStatus = status as typeof terminalStatus;
          }

          if (terminalStatus) {
            if (terminalStatus !== 'awaiting_approval' && !res.writableEnded) {
              res.write(JSON.stringify({ type: 'done', status: terminalStatus }) + '\n');
            }
            if (!res.writableEnded) {
              res.end();
            }
            cleanup();
            return;
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error('Failed run stream loop', { runId, error });
          if (!res.writableEnded) {
            res.write(JSON.stringify({ type: 'error', message: 'Failed to read run stream' }) + '\n');
            res.end();
          }
        }
        cleanup();
      }
    };

    void readLoop();
  });

  return router;
}
