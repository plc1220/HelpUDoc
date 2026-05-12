import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import type { WorkspaceService } from '../../services/workspaceService';
import {
  cancelAgentRun,
  getRunMeta,
  getRunStreamKey,
  resumeAgentRun,
  startAgentRun,
} from '../../services/agentRunService';
import { blockingRedisClient } from '../../services/redisService';
import { signAgentContextToken } from '../../services/agentToken';
import { HttpError } from '../../errors';
import { resolveWorkspaceRoot } from '../../config/workspaceRoot';
import { pathExists } from '../../services/skills/registry';

const repoRoot = path.resolve(__dirname, '../../../../');
const workspaceRoot = resolveWorkspaceRoot();
const skillBuilderStorageRoot = path.join(repoRoot, '.local-run', 'skill-builder');
const contextFilesRoot = path.join(skillBuilderStorageRoot, 'context-files');
const ENABLE_SKILL_BUILDER_ASSISTANT = String(process.env.ENABLE_SKILL_BUILDER_ASSISTANT ?? 'true').toLowerCase() !== 'false';
const ENABLE_SKILL_SANDBOX_RUNNER =
  String(process.env.ENABLE_SKILL_SANDBOX_RUNNER ?? process.env.ENABLE_SKILL_SCRIPT_RUNNER ?? 'false').toLowerCase() === 'true';
const CONTEXT_ALLOWED_EXTENSIONS = [
  '.py', '.md', '.txt', '.pdf', '.csv', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
];
const CONTEXT_MAX_FILE_SIZE = 20 * 1024 * 1024;
const SKILL_BUILDER_PERSONA = 'skill-builder';

export type ContextFileMeta = {
  fileId: string;
  userId: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

const skillBuilderWorkspaceByUser = new Map<string, string>();
const contextFilesByUser = new Map<string, ContextFileMeta[]>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CONTEXT_MAX_FILE_SIZE,
    files: 1,
  },
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

const ensureSkillBuilderWorkspace = async (user: { userId: string; displayName: string }): Promise<string> => {
  const cached = skillBuilderWorkspaceByUser.get(user.userId);
  if (cached) {
    return cached;
  }

  const workspaceId = `skill-builder-${user.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const workspacePath = path.join(workspaceRoot, workspaceId);
  await fs.mkdir(workspacePath, { recursive: true });
  skillBuilderWorkspaceByUser.set(user.userId, workspaceId);
  return workspaceId;
};

export function getContextFilesForUser(userId: string): ContextFileMeta[] {
  return contextFilesByUser.get(userId) || [];
}

export function setContextFilesForUser(userId: string, files: ContextFileMeta[]) {
  contextFilesByUser.set(userId, files);
}

const guessMimeType = (fileName: string): string => {
  const ext = path.extname(fileName).toLowerCase();
  if (['.md', '.txt', '.py', '.json', '.yaml', '.yml', '.csv'].includes(ext)) {
    return 'text/plain';
  }
  if (ext === '.pdf') return 'application/pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
    return `image/${ext.replace('.', '').replace('jpg', 'jpeg')}`;
  }
  return 'application/octet-stream';
};

export function registerSkillBuilderRoutes(router: Router, _workspaceService: WorkspaceService) {
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
      if (ENABLE_SKILL_SANDBOX_RUNNER) {
        const token = signAgentContextToken({
          sub: user.userId,
          userId: user.userId,
          workspaceId,
          isAdmin: true,
          mcpServerAllowIds: [],
          mcpServerDenyIds: [],
          allowSkillSandbox: true,
        });
        if (token) {
          authToken = token;
        }
      }

      const { runId, status } = await startAgentRun({
        workspaceId,
        userId: user.userId,
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
}
