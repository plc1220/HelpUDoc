import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { HttpError } from '../../errors';
import { signAgentContextToken } from '../../services/agentToken';
import { GoogleOAuthService, GoogleOAuthTokenMissingError } from '../../services/googleOAuthService';
import type { UserService } from '../../services/userService';

const AUTH_MODE = (process.env.AUTH_MODE || 'headers').trim().toLowerCase();
const ENABLE_SKILL_SANDBOX_RUNNER =
  String(process.env.ENABLE_SKILL_SANDBOX_RUNNER ?? 'false').toLowerCase() === 'true';
const BQ_DELEGATED_MCP_SERVER_ID = 'toolbox-bq-demo';

const repoRoot = path.resolve(__dirname, '../../../../');
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

export type EffectiveAgentPolicy = {
  isAdmin: boolean;
  skillAllowIds: string[];
  mcpServerAllowIds: string[];
  mcpServerDenyIds: string[];
};

const normalizeUniqueIds = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

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

export async function loadRuntimeMcpServers(): Promise<RuntimeMcpServerConfig[]> {
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
}

export function createAgentPolicyApi(googleOAuthService: GoogleOAuthService, userService: UserService) {
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
    if (ENABLE_SKILL_SANDBOX_RUNNER) {
      payload.allowSkillSandbox = true;
    }

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

  return {
    getAllowedDelegatedGoogleServerIds,
    buildAgentAuthToken,
    loadRuntimeMcpServers,
    resolveEffectiveAgentPolicy,
  };
}
