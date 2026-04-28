import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { runAgent, runAgentStream, type AgentMessageContentBlock } from '../services/agentService';
import { WorkspaceService } from '../services/workspaceService';
import { FileService } from '../services/fileService';
import { HttpError } from '../errors';
import {
  buildPresentationHtmlPrompt,
  extractHtmlFromAgentResponse,
  renderFallbackPresentation,
} from '../services/presentationService';
import { Paper2SlidesService } from '../services/paper2SlidesService';
import { Paper2SlidesJobService } from '../services/paper2SlidesJobService';
import type { PresentationSourceFile } from '../types/presentation';
import {
  cancelAgentRun,
  getRunMeta,
  getRunStreamKey,
  resumeAgentRun,
  resumeAgentRunWithAction,
  resumeAgentRunWithResponse,
  startAgentRun,
} from '../services/agentRunService';
import { blockingRedisClient } from '../services/redisService';
import { signAgentContextToken } from '../services/agentToken';
import { GoogleOAuthService, GoogleOAuthTokenMissingError } from '../services/googleOAuthService';
import { UserService } from '../services/userService';

const DEFAULT_PRESENTATION_PERSONA = 'fast';
const IMAGE_NAME_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';
const AUTH_MODE = (process.env.AUTH_MODE || 'headers').trim().toLowerCase();
const BQ_DELEGATED_MCP_SERVER_ID = 'toolbox-bq-demo';
const DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES = 8 * 1024 * 1024;
const repoRoot = path.resolve(__dirname, '../../..');
const skillsRoot = process.env.SKILLS_ROOT || path.join(repoRoot, 'skills');
const resolveRepoRelativePath = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
};
const defaultAgentConfigDir = existsSync('/agent/config')
  ? '/agent/config'
  : path.join(repoRoot, 'agent', 'config');
const agentConfigPath = resolveRepoRelativePath(process.env.AGENT_CONFIG_PATH)
  || path.join(resolveRepoRelativePath(process.env.AGENT_CONFIG_DIR) || defaultAgentConfigDir, 'runtime.yaml');
const repoAgentConfigPath = path.join(repoRoot, 'agent', 'config', 'runtime.yaml');

type RuntimeConfigShape = {
  mcp_servers?: RuntimeMcpServerConfig[];
  [key: string]: unknown;
};

type RuntimeMcpServerConfig = {
  name: string;
  transport?: string;
  default_access?: string;
  defaultAccess?: string;
  delegated_auth_provider?: string;
  delegatedAuthProvider?: string;
};

type SlashSkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
};

type EffectiveAgentPolicy = {
  isAdmin: boolean;
  skillAllowIds: string[];
  mcpServerAllowIds: string[];
  mcpServerDenyIds: string[];
};

const normalizeUniqueIds = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

const resolveCurrentTurnMultimodalMaxBytes = (): number => {
  const raw = Number(process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES || DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CURRENT_TURN_MULTIMODAL_MAX_BYTES;
};

const CURRENT_TURN_MULTIMODAL_MAX_BYTES = resolveCurrentTurnMultimodalMaxBytes();

const extractFrontmatterString = (frontmatter: Record<string, unknown>, key: string): string | undefined => {
  const value = frontmatter[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const parseSkillFrontmatter = (content: string): Record<string, unknown> => {
  if (!content.startsWith('---')) {
    return {};
  }
  const closingIndex = content.indexOf('\n---', 3);
  if (closingIndex < 0) {
    return {};
  }
  const frontmatter = content.slice(3, closingIndex).trim();
  const parsed = parseYaml(frontmatter);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
};

const collectSkillIds = async (rootDir: string, relativeDir = ''): Promise<string[]> => {
  const entries = await fs.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relPath = path.join(relativeDir, entry.name);
    const skillFile = path.join(rootDir, relPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      results.push(relPath.replace(/\\/g, '/'));
    }
    const nested = await collectSkillIds(rootDir, relPath);
    results.push(...nested);
  }

  return Array.from(new Set(results)).sort((a, b) => a.localeCompare(b));
};

const getSkillMetadata = async (skillId: string): Promise<SlashSkillMetadata> => {
  const skillPath = path.join(skillsRoot, skillId, 'SKILL.md');
  const content = await fs.readFile(skillPath, 'utf-8');
  const frontmatter = parseSkillFrontmatter(content);
  const description = extractFrontmatterString(frontmatter, 'description');
  const name = extractFrontmatterString(frontmatter, 'name') || skillId;
  return {
    id: skillId,
    name,
    description,
    valid: true,
  };
};

const extractTextFromAgentReply = (reply: unknown): string => {
  if (reply === null || reply === undefined) {
    return '';
  }
  if (typeof reply === 'string') {
    return reply;
  }
  if (Array.isArray(reply)) {
    return reply.map((item) => extractTextFromAgentReply(item)).join('\n');
  }
  if (typeof reply === 'object') {
    const payload = reply as Record<string, unknown>;
    if (typeof payload.content === 'string') {
      return payload.content;
    }
    if (Array.isArray(payload.content)) {
      return payload.content.map((item) => extractTextFromAgentReply(item)).join('');
    }
    if (typeof payload.text === 'string') {
      return payload.text;
    }
    if (Array.isArray(payload.messages)) {
      return payload.messages.map((item) => extractTextFromAgentReply(item)).join('\n');
    }
  }
  try {
    return JSON.stringify(reply);
  } catch {
    return String(reply);
  }
};

const normalizeDelegatedAuthProvider = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const normalizeDefaultAccess = (value: unknown): 'allow' | 'deny' => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'deny' ? 'deny' : 'allow';
};

const mergeRuntimeMcpServers = (
  baseEntries: unknown,
  overrideEntries: unknown,
): RuntimeMcpServerConfig[] => {
  const merged = new Map<string, RuntimeMcpServerConfig>();
  for (const source of [baseEntries, overrideEntries]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!entry || typeof entry !== 'object' || typeof (entry as any).name !== 'string') continue;
      const name = (entry as any).name;
      merged.set(name, { ...(merged.get(name) || {}), ...(entry as RuntimeMcpServerConfig) });
    }
  }
  return Array.from(merged.values());
};

const loadRuntimeMcpServers = async (): Promise<RuntimeMcpServerConfig[]> => {
  try {
    const [baseContent, liveContent] = await Promise.all([
      fs.readFile(repoAgentConfigPath, 'utf-8').catch(() => ''),
      fs.readFile(agentConfigPath, 'utf-8'),
    ]);
    const baseParsed = (parseYaml(baseContent) as RuntimeConfigShape | null) || {};
    const liveParsed = (parseYaml(liveContent) as RuntimeConfigShape | null) || {};
    return mergeRuntimeMcpServers(baseParsed.mcp_servers, liveParsed.mcp_servers)
      .filter((entry): entry is RuntimeMcpServerConfig => Boolean(entry && typeof entry === 'object' && (entry as any).name));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('Failed to read runtime MCP config; falling back to BigQuery delegated MCP server only', error);
    }
    return [
      {
        name: BQ_DELEGATED_MCP_SERVER_ID,
        transport: 'http',
        delegated_auth_provider: 'google',
        default_access: 'allow',
      },
    ];
  }
};

export default function(
  workspaceService: WorkspaceService,
  fileService: FileService,
  googleOAuthService: GoogleOAuthService,
  userService: UserService,
) {
  const router = Router();
  const paper2SlidesService = new Paper2SlidesService(fileService);
  const paper2SlidesJobService = new Paper2SlidesJobService(fileService, workspaceService, paper2SlidesService);

  const runAgentSchema = z.object({
    persona: z.string().min(1),
    prompt: z.string().min(1),
    workspaceId: z.string().min(1),
    history: z.array(z.object({
      role: z.string().min(1),
      content: z.string().min(1),
    })).optional(),
    forceReset: z.boolean().optional(),
    turnId: z.string().optional(),
    taggedFiles: z.array(z.string().min(1)).optional(),
    currentTurnFileIds: z.array(z.number().int().positive()).optional(),
    fileContextRefs: z.array(z.object({
      sourceFileId: z.number().int().positive(),
      sourceName: z.string().min(1),
      sourceMimeType: z.string().nullable().optional(),
      sourceVersionFingerprint: z.string().min(1),
      artifactId: z.string().min(1),
      artifactVersion: z.number().int().positive(),
      derivedArtifactFileId: z.number().int().positive().nullable().optional(),
      derivedArtifactPath: z.string().nullable().optional(),
      effectiveMode: z.enum(['part', 'parser', 'hybrid']),
      status: z.enum(['pending', 'partial', 'ready', 'failed', 'superseded']),
      summary: z.string().nullable().optional(),
      lastError: z.string().nullable().optional(),
    }).strict()).optional(),
  });

  const presentationSchema = z.object({
    workspaceId: z.string().min(1),
    fileIds: z.array(z.number().int().positive()).min(1),
    brief: z.string().optional(),
    persona: z.string().min(1).optional(),
    output: z.enum(['slides', 'poster']).optional(),
    content: z.enum(['paper', 'general']).optional(),
    style: z.string().optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    mode: z.enum(['fast', 'normal']).optional(),
    parallel: z.union([z.number().int().positive(), z.boolean()]).optional(),
    fromStage: z.enum(['rag', 'analysis', 'summary', 'plan', 'generate']).optional(),
    exportPptx: z.boolean().optional(),
  });

  const pptxExportSchema = z.object({
    workspaceId: z.string().min(1),
    fileId: z.number().int().positive(),
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
  const runResponseSchema = z.object({
    message: z.string().optional(),
    selectedChoiceIds: z.array(z.string().min(1)).optional(),
    selectedValues: z.array(z.string()).optional(),
    answersByQuestionId: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  });
  const runActionSchema = z.object({
    actionId: z.string().min(1),
    text: z.string().optional(),
  });

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  router.get('/slash-metadata', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const promptAccess = await userService.getEffectivePromptAccess(user.userId);
      if (!promptAccess) {
        throw new HttpError(401, 'User not found');
      }
      await fs.mkdir(skillsRoot, { recursive: true });
      const skillIds = await collectSkillIds(skillsRoot);
      const skills: SlashSkillMetadata[] = [];
      const allowedSkillIds = new Set(promptAccess.skillIds);
      for (const skillId of skillIds) {
        if (!promptAccess.isAdmin && !allowedSkillIds.has(skillId)) {
          continue;
        }
        try {
          skills.push(await getSkillMetadata(skillId));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to read skill';
          skills.push({
            id: skillId,
            name: skillId,
            valid: false,
            error: message,
          });
        }
      }

      const allowedMcpServerIds = new Set(promptAccess.mcpServerIds);
      const mcpServers = (await loadRuntimeMcpServers())
        .map((server) => ({
          name: typeof server.name === 'string' ? server.name.trim() : '',
          description: undefined as string | undefined,
        }))
        .filter((server) => promptAccess.isAdmin || allowedMcpServerIds.has(server.name))
        .filter((server) => server.name);

      res.json({ skills, mcpServers });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      console.error('Failed to load slash metadata', error);
      return res.status(500).json({ error: 'Failed to load slash metadata' });
    }
  });

  const getAllowedDelegatedGoogleServerIds = async (policy: {
    isAdmin: boolean;
    mcpServerAllowIds: string[];
    mcpServerDenyIds: string[];
  }): Promise<string[]> => {
    const configuredServers = await loadRuntimeMcpServers();
    const allowIds = new Set(policy.mcpServerAllowIds || []);
    const denyIds = new Set(policy.mcpServerDenyIds || []);

    return configuredServers
      .filter((server) => {
        const serverId = typeof server.name === 'string' ? server.name.trim() : '';
        if (!serverId) {
          return false;
        }
        const transport = typeof server.transport === 'string' ? server.transport.trim().toLowerCase() : '';
        if (transport !== 'http') {
          return false;
        }
        if (normalizeDelegatedAuthProvider(server.delegated_auth_provider ?? server.delegatedAuthProvider) !== 'google') {
          return false;
        }
        if (policy.isAdmin) {
          return true;
        }
        if (denyIds.has(serverId)) {
          return false;
        }
        if (normalizeDefaultAccess(server.default_access ?? server.defaultAccess) === 'deny' && !allowIds.has(serverId)) {
          return false;
        }
        return true;
      })
      .map((server) => server.name.trim())
      .sort();
  };

  const buildMcpAuthFingerprint = (
    provider: string,
    serverIds: string[],
    bearerToken: string,
    expiresAt: number,
  ): string => {
    const tokenHash = crypto.createHash('sha256').update(bearerToken).digest('hex');
    const expBucket = Math.floor(expiresAt / 60);
    return crypto
      .createHash('sha256')
      .update(`${provider}|${serverIds.join(',')}|${expBucket}|${tokenHash}`)
      .digest('hex');
  };

  const buildAgentAuthToken = async (input: {
    userId: string;
    workspaceId: string;
    policy: EffectiveAgentPolicy;
    skipPlanApprovals?: boolean;
  }): Promise<string | null> => {
    const payload: Record<string, unknown> = {
      sub: input.userId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      skipPlanApprovals: Boolean(input.skipPlanApprovals),
      ...input.policy,
    };

    if (AUTH_MODE !== 'headers') {
      try {
        const delegatedServerIds = await getAllowedDelegatedGoogleServerIds(input.policy);
        if (!delegatedServerIds.length) {
          return signAgentContextToken(payload);
        }
        const delegated = await googleOAuthService.getDelegatedAccessToken(input.userId);
        const authorization = `Bearer ${delegated.accessToken}`;
        const fingerprint = buildMcpAuthFingerprint(
          'google',
          delegatedServerIds,
          delegated.accessToken,
          delegated.expiresAt,
        );
        payload.mcpAuth = Object.fromEntries(
          delegatedServerIds.map((serverId) => [
            serverId,
            {
              Authorization: authorization,
            },
          ]),
        );
        payload.mcpAuthFingerprint = fingerprint;
        console.info('[mcp-auth]', {
          userId: input.userId,
          workspaceId: input.workspaceId,
          provider: 'google',
          serverIds: delegatedServerIds,
          tokenSource: delegated.source,
          expBucket: Math.floor(delegated.expiresAt / 60),
        });
      } catch (error) {
        if (error instanceof GoogleOAuthTokenMissingError) {
          throw new HttpError(
            403,
            'Google access for MCP tools is not connected or is missing required permissions. Please sign in with Google again.',
          );
        }
        throw error;
      }
    }

    return signAgentContextToken(payload);
  };

  const resolveEffectiveAgentPolicy = async (
    userId: string,
    workspacePolicy: {
      mcpServerAllowIds: string[];
      mcpServerDenyIds: string[];
    },
  ): Promise<EffectiveAgentPolicy> => {
    const promptAccess = await userService.getEffectivePromptAccess(userId);
    if (!promptAccess) {
      throw new HttpError(401, 'User not found');
    }
    if (promptAccess.isAdmin) {
      return {
        isAdmin: true,
        skillAllowIds: [],
        mcpServerAllowIds: [],
        mcpServerDenyIds: [],
      };
    }

    const configuredServers = await loadRuntimeMcpServers();
    const groupAllowedServerIds = new Set(promptAccess.mcpServerIds);
    const workspaceAllowIds = new Set(normalizeUniqueIds(workspacePolicy.mcpServerAllowIds || []));
    const workspaceDenyIds = new Set(normalizeUniqueIds(workspacePolicy.mcpServerDenyIds || []));
    const finalAllowIds = new Set<string>();
    const finalDenyIds = new Set<string>(workspaceDenyIds);

    configuredServers.forEach((server) => {
      const serverId = typeof server.name === 'string' ? server.name.trim() : '';
      if (!serverId) {
        return;
      }
      if (!groupAllowedServerIds.has(serverId)) {
        finalDenyIds.add(serverId);
        return;
      }
      if (workspaceDenyIds.has(serverId)) {
        finalDenyIds.add(serverId);
        return;
      }
      if (normalizeDefaultAccess(server.default_access ?? server.defaultAccess) === 'deny' && !workspaceAllowIds.has(serverId)) {
        finalDenyIds.add(serverId);
        return;
      }
      finalAllowIds.add(serverId);
    });

    return {
      isAdmin: false,
      skillAllowIds: normalizeUniqueIds(promptAccess.skillIds),
      mcpServerAllowIds: Array.from(finalAllowIds).sort((a, b) => a.localeCompare(b)),
      mcpServerDenyIds: Array.from(finalDenyIds).sort((a, b) => a.localeCompare(b)),
    };
  };

  router.post('/paper2slides/jobs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const {
        workspaceId,
        fileIds,
        brief,
        persona,
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      } = presentationSchema.parse(req.body);

      const job = await paper2SlidesJobService.createJob({
        workspaceId,
        userId: user.userId,
        fileIds,
        brief,
        persona,
        options: {
          output,
          content,
          style,
          length,
          mode,
          parallel,
          fromStage,
          exportPptx,
        },
      });

      res.json({ jobId: job.id, status: job.status, createdAt: job.createdAt });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to start Paper2Slides job');
    }
  });

  router.get('/paper2slides/jobs/:jobId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { jobId } = req.params;
      const job = await paper2SlidesJobService.getJob(jobId, user.userId);
      res.json({
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error: any) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to fetch Paper2Slides job');
    }
  });

  router.post('/paper2slides/export-pptx', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { workspaceId, fileId } = pptxExportSchema.parse(req.body);
      const result = await paper2SlidesService.exportPptxFromPdf(workspaceId, user.userId, fileId);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      handleError(res, error, 'Failed to export PPTX');
    }
  });

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  const isImageFile = (file: any): boolean => {
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
    if (mimeType.startsWith('image/')) {
      return true;
    }
    return IMAGE_NAME_PATTERN.test(String(file.name || ''));
  };

  const normalizeTaggedValue = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\/+/, '');

  const injectTaggedFileUrls = async (
    prompt: string,
    workspaceId: string,
    userId: string,
    explicitTaggedFiles?: string[],
  ) => {
    const normalizedExplicit = Array.from(
      new Set((explicitTaggedFiles || []).map((value) => normalizeTaggedValue(String(value || ''))).filter(Boolean)),
    );
    if ((!prompt || !prompt.includes('@')) && !normalizedExplicit.length) {
      return prompt;
    }
    const files = await fileService.getFiles(workspaceId, userId);
    const explicitBasenames = new Set(normalizedExplicit.map((value) => path.posix.basename(value)));
    const tagged = files.filter((file) => {
      const fileName = typeof file.name === 'string' ? normalizeTaggedValue(file.name) : '';
      if (!fileName) {
        return false;
      }
      if (normalizedExplicit.length) {
        return normalizedExplicit.includes(fileName) || explicitBasenames.has(path.posix.basename(fileName));
      }
      return prompt.includes(`@${file.name}`);
    });
    const withUrls = tagged.filter((file) => file.publicUrl && isImageFile(file));
    const taggedPaths = Array.from(
      new Set(
        tagged
          .map((file) => (typeof file.name === 'string' ? file.name.trim() : ''))
          .filter((name) => name.length > 0),
      ),
    ).map((name) => (name.startsWith('/') ? name : `/${name}`));

    if (!withUrls.length && !taggedPaths.length) {
      return prompt;
    }
    const fileHint = taggedPaths.length
      ? `\n\nTagged files (preferred for retrieval):\n${taggedPaths.map((path) => `- ${path}`).join('\n')}`
      : '';
    const urlList = withUrls
      .map((file) => `- ${file.name}: ${file.publicUrl}`)
      .join('\n');
    const urlHint = withUrls.length
      ? `\n\nTagged image URLs (use these HTTP links instead of file paths in HTML/Markdown/Mermaid):\n${urlList}`
      : '';
    return `${prompt}${fileHint}${urlHint}`;
  };

  const buildCurrentTurnMessageContent = async (
    workspaceId: string,
    userId: string,
    prompt: string,
    currentTurnFileIds?: number[],
  ): Promise<AgentMessageContentBlock[] | undefined> => {
    const normalizedIds = Array.from(
      new Set(
        (currentTurnFileIds || [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );
    if (!normalizedIds.length) {
      return undefined;
    }

    const fileBlocks: AgentMessageContentBlock[] = [];

    for (const fileId of normalizedIds) {
      const file = await fileService.getFileContent(fileId, userId);
      const mimeType = typeof file.mimeType === 'string' && file.mimeType.trim()
        ? file.mimeType.trim()
        : 'application/octet-stream';
      const encoded = typeof file.content === 'string' ? file.content : '';
      if (!encoded) {
        continue;
      }
      const byteLength = Buffer.byteLength(encoded, 'base64');
      if (byteLength > CURRENT_TURN_MULTIMODAL_MAX_BYTES) {
        console.info('Skipping oversized current-turn multimodal attachment', {
          workspaceId,
          fileId,
          fileName: file.name,
          mimeType,
          byteLength,
          maxBytes: CURRENT_TURN_MULTIMODAL_MAX_BYTES,
        });
        continue;
      }
      if (mimeType === 'application/pdf') {
        fileBlocks.push({
          type: 'file',
          base64: encoded,
          mime_type: mimeType,
          filename: String(file.name || `attachment-${fileId}.pdf`),
        });
      } else if (mimeType.startsWith('image/')) {
        fileBlocks.push({
          type: 'image',
          base64: encoded,
          mime_type: mimeType,
        });
      }
    }

    if (!fileBlocks.length) {
      return undefined;
    }

    const promptText = [
      prompt.trim(),
      'Use the attached file content as primary context for this turn before falling back to workspace search or web search.',
    ]
      .filter(Boolean)
      .join('\n\n');

    return promptText
      ? [{ type: 'text', text: promptText }, ...fileBlocks]
      : fileBlocks;
  };

  router.post('/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, currentTurnFileIds, fileContextRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
      const response = await runAgent(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        authToken: authToken || undefined,
        fileContextRefs,
        messageContent,
        traceContext: {
          userId: user.userId,
          workspaceId,
          persona,
        },
      });
      res.json(response);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to run agent');
    }
  });

  router.post('/run-stream', async (req, res) => {
    const upstreamAbort = new AbortController();
    let streamResponse: Awaited<ReturnType<typeof runAgentStream>> | null = null;
    let cleanedUp = false;

    const cleanupListeners = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      req.off('close', handleClientClose);
      res.off('close', handleClientClose);
    };

    const handleClientClose = () => {
      upstreamAbort.abort();
      if (streamResponse?.data && !streamResponse.data.destroyed) {
        streamResponse.data.destroy();
      }
      cleanupListeners();
    };

    req.on('close', handleClientClose);
    res.on('close', handleClientClose);

    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset, taggedFiles, currentTurnFileIds, fileContextRefs } = runAgentSchema.parse(req.body);
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
      streamResponse = await runAgentStream(persona, workspaceId, enrichedPrompt, history, {
        forceReset,
        signal: upstreamAbort.signal,
        authToken: authToken || undefined,
        fileContextRefs,
        messageContent,
        traceContext: {
          userId: user.userId,
          workspaceId,
          persona,
        },
      });
      res.setHeader('Content-Type', 'application/jsonl');
      streamResponse.data.on('data', (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });
      streamResponse.data.on('end', () => {
        if (!res.writableEnded) {
          res.end();
        }
        cleanupListeners();
      });
      streamResponse.data.on('error', (error: Error) => {
        console.error("Agent stream error", error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Agent stream failed' });
        } else {
          if (!res.writableEnded) {
            res.end();
          }
        }
        cleanupListeners();
      });
    } catch (error: any) {
      cleanupListeners();
      if (error?.code === 'ERR_CANCELED') {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to stream agent response');
    }
  });

  router.post('/runs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { persona, prompt, workspaceId, history, forceReset, turnId, taggedFiles, currentTurnFileIds, fileContextRefs } = runAgentSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(workspaceId, user.userId, { requireEdit: true });
      const enrichedPrompt = await injectTaggedFileUrls(prompt, workspaceId, user.userId, taggedFiles);
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      const messageContent = await buildCurrentTurnMessageContent(workspaceId, user.userId, enrichedPrompt, currentTurnFileIds);
      const { runId, status } = await startAgentRun({
        persona,
        workspaceId,
        prompt: enrichedPrompt,
        userId: user.userId,
        history,
        forceReset,
        turnId,
        authToken: authToken || undefined,
        fileContextRefs,
        messageContent,
      });
      res.json({ runId, status });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to start agent run');
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(req.params.runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      res.json(meta);
    } catch (error) {
      handleError(res, error, 'Failed to fetch run status');
    }
  });

  router.post('/runs/:runId/cancel', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(req.params.runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      await cancelAgentRun(req.params.runId);
      res.json({ status: 'cancelled' });
    } catch (error) {
      handleError(res, error, 'Failed to cancel run');
    }
  });

  router.post('/runs/:runId/decision', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting approval' });
      }
      if (meta.pendingInterrupt?.kind === 'clarification') {
        return res.status(409).json({ error: 'Run is awaiting a clarification response, not an approval decision' });
      }
      const payload = runDecisionSchema.parse(req.body);
      console.info('[AgentDecision]', {
        runId,
        workspaceId: meta.workspaceId,
        decision: payload.decision,
        status: meta.status,
      });
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
      const result = await resumeAgentRun(runId, decisions, {
        authToken: authToken || undefined,
      });
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to submit run decision');
    }
  });

  router.post('/runs/:runId/respond', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting input' });
      }
      const interruptKind = meta.pendingInterrupt?.kind ?? 'approval';
      if (interruptKind !== 'clarification') {
        return res.status(409).json({ error: 'Run is awaiting an approval decision, not a clarification response' });
      }
      const payload = runResponseSchema.parse(req.body);
      if (!payload.message && !payload.selectedChoiceIds?.length && !payload.selectedValues?.length) {
        const hasStructuredAnswers = Boolean(
          payload.answersByQuestionId && Object.keys(payload.answersByQuestionId).length,
        );
        if (!hasStructuredAnswers) {
          return res.status(400).json({ error: 'Clarification response requires a message or a selected choice' });
        }
      }
      const result = await resumeAgentRunWithResponse(runId, {
        message: payload.message,
        selectedChoiceIds: payload.selectedChoiceIds,
        selectedValues: payload.selectedValues,
        answersByQuestionId: payload.answersByQuestionId,
      }, {
        authToken: authToken || undefined,
        previousInterrupt: meta.pendingInterrupt,
      });
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to submit clarification response');
    }
  });

  router.post('/runs/:runId/act', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { runId } = req.params;
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
      const workspacePolicy = await workspaceService.getMcpServerPolicy(meta.workspaceId, user.userId, { requireEdit: true });
      const policy = await resolveEffectiveAgentPolicy(user.userId, workspacePolicy);
      const settings = await workspaceService.getWorkspaceSettings(meta.workspaceId, user.userId, { requireEdit: true });
      const authToken = await buildAgentAuthToken({
        userId: user.userId,
        workspaceId: meta.workspaceId,
        policy,
        skipPlanApprovals: settings.skipPlanApprovals,
      });
      if (meta.status !== 'awaiting_approval') {
        return res.status(409).json({ error: 'Run is not awaiting human input' });
      }
      const payload = runActionSchema.parse(req.body);
      const interruptActions = Array.isArray(meta.pendingInterrupt?.actions) ? meta.pendingInterrupt.actions : [];
      const action = interruptActions.find((item) => item.id === payload.actionId);
      if (!action) {
        return res.status(404).json({ error: `Interrupt action "${payload.actionId}" was not found` });
      }
      if (action.inputMode === 'text' && !payload.text?.trim()) {
        return res.status(400).json({ error: 'This action requires text input' });
      }
      const result = await resumeAgentRunWithAction(
        runId,
        {
          action: {
            id: action.id,
            ...(typeof action.value === 'string' ? { value: action.value } : {}),
            ...(action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
              ? { payload: action.payload }
              : {}),
            ...(payload.text?.trim() ? { text: payload.text.trim() } : {}),
          },
        },
        {
          authToken: authToken || undefined,
        },
      );
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid interrupt action payload' });
      }
      handleError(res, error, 'Failed to submit interrupt action');
    }
  });

  router.get('/runs/:runId/stream', async (req, res) => {
    const { runId } = req.params;
    const after = typeof req.query.after === 'string' && req.query.after.trim() ? req.query.after : '0-0';
    const abortController = new AbortController();

    let streamKey: string | null = null;
    let terminalStatus: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | null = null;

    try {
      const user = requireUserContext(req);
      const meta = await getRunMeta(runId);
      if (!meta) {
        return res.status(404).json({ error: 'Run not found' });
      }
      await workspaceService.ensureMembership(meta.workspaceId, user.userId, { requireEdit: true });
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

    // NDJSON/JSONL streaming over fetch() should not be buffered by proxies.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx-style hint (harmless elsewhere). Helps avoid proxy buffering that can make the UI look "stuck".
    res.setHeader('X-Accel-Buffering', 'no');
    // Send headers immediately so the browser starts streaming right away.
    (res as any).flushHeaders?.();
    if (DEBUG_AGENT_RUN_STREAM) {
      console.info('[agent-run-stream] client connected', { runId, after });
    }

    const readLoop = async () => {
      if (!streamKey) {
        return;
      }
      let lastId = after;
      try {
        while (!abortController.signal.aborted && !res.writableEnded) {
          const streams = await blockingRedisClient.xRead(
            { key: streamKey, id: lastId },
            { BLOCK: 10000, COUNT: 50 }
          );
          if (streams && streams.length) {
            for (const stream of streams) {
              for (const message of stream.messages) {
                const data = message.message.data;
                if (data && !res.writableEnded) {
                  // Attach the Redis stream entry id so clients can resume after transient disconnects.
                  // Keep backward compatibility by preserving the original payload shape.
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
                    // If the payload is not JSON (unexpected), stream it as-is.
                  }

                  res.write(`${line}\n`);
                  if (DEBUG_AGENT_RUN_STREAM) {
                    console.info('[agent-run-stream] sent', {
                      runId,
                      id: message.id,
                      bytes: line.length,
                      sample: line.slice(0, 160),
                    });
                  }
                }
                lastId = message.id;
              }
            }
          }
          // Keep the connection active even during long tool calls (some networks/LBs time out idle streams).
          if (!streams || !streams.length) {
            if (!res.writableEnded) {
              res.write('{"type":"keepalive"}\n');
            }
          }

          if (!terminalStatus) {
            const meta = await getRunMeta(runId);
            if (
              meta?.status === 'completed' ||
              meta?.status === 'failed' ||
              meta?.status === 'cancelled' ||
              meta?.status === 'awaiting_approval'
            ) {
              terminalStatus = meta.status;
            }
          }

          if (terminalStatus) {
            break;
          }
        }
      } catch (error) {
        if (!res.headersSent && !res.writableEnded) {
          res.status(500).json({ error: 'Run stream failed' });
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    void readLoop();
  });

  router.post('/presentation', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const {
        workspaceId,
        fileIds,
        brief,
        persona,
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      } = presentationSchema.parse(req.body);
      await workspaceService.ensureMembership(workspaceId, user.userId, { requireEdit: true });

      const files: PresentationSourceFile[] = [];
      const paper2SlidesFiles: Array<{ name: string; buffer: Buffer }> = [];
      for (const fileId of fileIds) {
        const file = await fileService.getFileContent(fileId, user.userId);
        if (file.workspaceId !== workspaceId) {
          throw new HttpError(400, 'One or more files do not belong to the selected workspace');
        }
        const mimeType = typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
        const isLikelyText =
          mimeType.startsWith('text/') ||
          mimeType === 'application/json' ||
          mimeType === 'text/markdown' ||
          mimeType === 'text/html' ||
          /\.md$/i.test(file.name) ||
          /\.txt$/i.test(file.name) ||
          /\.html?$/i.test(file.name) ||
          /\.json$/i.test(file.name);
        const contentStr = typeof file.content === 'string' ? file.content : '';
        const buffer = isLikelyText ? Buffer.from(contentStr, 'utf-8') : Buffer.from(contentStr, 'base64');
        paper2SlidesFiles.push({ name: file.name, buffer });

        if (isLikelyText) {
          files.push({
            id: file.id,
            name: file.name,
            path: file.path,
            content: contentStr,
          });
        }
      }

      // Attempt Paper2Slides pipeline first.
      const paper2SlidesOptions = {
        output,
        content,
        style,
        length,
        mode,
        parallel,
        fromStage,
        exportPptx,
      };

      try {
        const paperOutputs = await paper2SlidesService.generate(
          workspaceId,
          user.userId,
          paper2SlidesFiles,
          paper2SlidesOptions,
        );
        res.json(paperOutputs);
        return;
      } catch (paperError: any) {
        console.warn('Paper2Slides pipeline failed, falling back to HTML agent:', paperError?.message || paperError);
      }

      if (!files.length) {
        throw new HttpError(400, 'Paper2Slides failed and no text-based files are available for fallback generation');
      }

      const prompt = buildPresentationHtmlPrompt({
        brief,
        files,
      });
      const agentResponse = await runAgent(
        persona || DEFAULT_PRESENTATION_PERSONA,
        workspaceId,
        prompt,
        undefined,
        { forceReset: true },
      );
      const rawReply = extractTextFromAgentReply((agentResponse && (agentResponse as any).reply) || agentResponse);
      if (!rawReply) {
        throw new HttpError(502, 'Agent returned an empty response');
      }
      let htmlContent: string;
      try {
        htmlContent = extractHtmlFromAgentResponse(rawReply);
      } catch (error) {
        console.warn('Presentation agent output invalid, falling back to markdown renderer', error);
        try {
          htmlContent = renderFallbackPresentation(files, brief);
        } catch (fallbackError) {
          throw new HttpError(
            502,
            'Agent returned invalid presentation HTML and fallback failed',
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          );
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const htmlName = `presentations/presentation-${timestamp}.html`;
      await fileService.createFile(
        workspaceId,
        htmlName,
        Buffer.from(htmlContent, 'utf-8'),
        'text/html',
        user.userId,
      );

      res.json({
        htmlPath: htmlName,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to generate presentation');
    }
  });

  return router;
}
