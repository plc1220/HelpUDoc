import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { existsSync } from 'fs';

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

const updateConfigSchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

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

export function registerAgentConfigRoutes(router: Router) {
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
}
