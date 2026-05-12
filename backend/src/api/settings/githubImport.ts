import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import path from 'path';
import crypto from 'crypto';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { skillsRoot } from '../../services/skills/constants';
import {
  IMPORT_ALLOWED_PREFIXES,
  IMPORT_BLOCKED_EXTENSIONS,
  resolveSkillDir,
  resolveSkillFile,
  isAllowedActionPath,
  isValidSkillId,
} from '../../services/skills/paths';
import { pathExists } from '../../services/skills/registry';
import { HttpError } from '../../errors';
import { scaffoldSkill } from './skills';

const ENABLE_GITHUB_SKILL_IMPORTER = String(process.env.ENABLE_GITHUB_SKILL_IMPORTER ?? 'true').toLowerCase() !== 'false';

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

const githubImportSessions = new Map<string, GithubInspectSession>();

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
    Accept: 'application/vnd.github+json',
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

export function registerGithubImportRoutes(router: Router) {
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

      await fs.mkdir(skillsRoot, { recursive: true });
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
}
