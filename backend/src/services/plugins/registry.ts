import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { PluginDefinition } from '@helpudoc/contracts/types';
import { pluginsRoot, skillsRoot } from '../skills/constants';
import { collectSkillIds, pathExists } from '../skills/registry';

type PluginManifest = {
  id?: string;
  display_name?: string;
  displayName?: string;
  description?: string;
  default_skill?: string;
  defaultSkill?: string;
  skills?: unknown;
  default_tools?: unknown;
  defaultTools?: unknown;
  default_mcp_servers?: unknown;
  defaultMcpServers?: unknown;
  default_sandbox_scripts?: unknown;
  defaultSandboxScripts?: unknown;
  execution?: { mode?: string };
};

const normalizeList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
  }
  if (typeof value === 'string') {
    return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
  }
  return [];
};

const normalizeScriptNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .map((item) => {
      if (item && typeof item === 'object' && typeof (item as any).name === 'string') {
        return (item as any).name.trim();
      }
      return '';
    })
    .filter(Boolean)));
};

async function collectPluginManifestPaths(rootDir: string): Promise<string[]> {
  if (!await pathExists(rootDir)) {
    return [];
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const manifests: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const filename of ['plugin.yaml', 'plugin.yml']) {
      const candidate = path.join(rootDir, entry.name, filename);
      if (await pathExists(candidate)) {
        manifests.push(candidate);
        break;
      }
    }
  }
  return manifests.sort((a, b) => a.localeCompare(b));
}

function definitionFromManifest(
  manifestPath: string,
  manifest: PluginManifest,
  availableSkillIds: Set<string>,
): PluginDefinition {
  const fallbackId = path.basename(path.dirname(manifestPath));
  const id = String(manifest.id || fallbackId).trim() || fallbackId;
  const displayName = String(manifest.display_name || manifest.displayName || id).trim() || id;
  const defaultSkillId = String(manifest.default_skill || manifest.defaultSkill || '').trim();
  const skillIds = normalizeList(manifest.skills);
  const tools = normalizeList(manifest.default_tools ?? manifest.defaultTools);
  const mcpServers = normalizeList(manifest.default_mcp_servers ?? manifest.defaultMcpServers);
  const scripts = normalizeScriptNames(manifest.default_sandbox_scripts ?? manifest.defaultSandboxScripts);
  const executionMode = String(manifest.execution?.mode || 'scope_bundle').trim() || 'scope_bundle';
  const errors: string[] = [];

  if (!id) errors.push('Plugin id is missing.');
  if (!defaultSkillId) errors.push('default_skill is required.');
  if (defaultSkillId && !skillIds.includes(defaultSkillId)) {
    errors.push(`default_skill '${defaultSkillId}' is not listed in skills.`);
  }
  if (executionMode !== 'scope_bundle') {
    errors.push(`Unsupported execution mode for v1: ${executionMode}`);
  }
  for (const skillId of skillIds) {
    if (!availableSkillIds.has(skillId)) {
      errors.push(`Referenced skill '${skillId}' was not found.`);
    }
  }

  return {
    id,
    displayName,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    defaultSkillId,
    skillIds,
    tools,
    mcpServers,
    scripts,
    valid: errors.length === 0,
    ...(errors.length ? { errors } : {}),
  };
}

export async function listPlugins(options?: {
  rootDir?: string;
  skillRootDir?: string;
}): Promise<PluginDefinition[]> {
  const rootDir = options?.rootDir || pluginsRoot;
  const skillRootDir = options?.skillRootDir || skillsRoot;
  const [manifestPaths, skillIds] = await Promise.all([
    collectPluginManifestPaths(rootDir),
    collectSkillIds(skillRootDir).catch(() => []),
  ]);
  const availableSkillIds = new Set(skillIds);
  const plugins: PluginDefinition[] = [];

  for (const manifestPath of manifestPaths) {
    try {
      const parsed = parseYaml(await fs.readFile(manifestPath, 'utf-8')) as PluginManifest | null;
      plugins.push(definitionFromManifest(manifestPath, parsed || {}, availableSkillIds));
    } catch (error) {
      const fallbackId = path.basename(path.dirname(manifestPath));
      const message = error instanceof Error ? error.message : 'Failed to read plugin manifest';
      plugins.push({
        id: fallbackId,
        displayName: fallbackId,
        defaultSkillId: '',
        skillIds: [],
        tools: [],
        mcpServers: [],
        scripts: [],
        valid: false,
        errors: [message],
      });
    }
  }

  return plugins.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function buildPluginBySkillMap(plugins: PluginDefinition[]): Map<string, PluginDefinition> {
  const map = new Map<string, PluginDefinition>();
  for (const plugin of plugins) {
    for (const skillId of plugin.skillIds) {
      if (!map.has(skillId)) {
        map.set(skillId, plugin);
      }
    }
  }
  return map;
}

export function filterPluginsForAccess(
  plugins: PluginDefinition[],
  access: { isAdmin: boolean; skillIds: string[]; mcpServerIds: string[] },
): PluginDefinition[] {
  const allowedSkills = new Set(access.skillIds);
  const allowedMcpServers = new Set(access.mcpServerIds);
  return plugins
    .filter((plugin) => access.isAdmin || allowedSkills.has(plugin.defaultSkillId))
    .map((plugin) => ({
      ...plugin,
      skillIds: access.isAdmin ? plugin.skillIds : plugin.skillIds.filter((skillId) => allowedSkills.has(skillId)),
      mcpServers: access.isAdmin
        ? plugin.mcpServers
        : plugin.mcpServers.filter((serverId) => allowedMcpServers.has(serverId)),
    }));
}
