import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import { extractFrontmatter } from './frontmatter';
import { pathExists } from './registry';
import { resolveSkillDir } from './paths';
import type { PluginDefinition } from '@helpudoc/contracts/types';

export type SkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
  pluginId?: string;
  pluginName?: string;
};

const withPluginMetadata = (
  metadata: SkillMetadata,
  pluginBySkill?: Map<string, PluginDefinition>,
): SkillMetadata => {
  const plugin = pluginBySkill?.get(metadata.id);
  if (!plugin) return metadata;
  return {
    ...metadata,
    pluginId: plugin.id,
    pluginName: plugin.displayName,
  };
};

export async function getSkillMetadata(
  skillId: string,
  pluginBySkill?: Map<string, PluginDefinition>,
): Promise<SkillMetadata> {
  const skillDir = resolveSkillDir(skillId);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!await pathExists(skillFile)) {
    return withPluginMetadata({
      id: skillId,
      name: skillId,
      description: 'No SKILL.md found',
      valid: false,
      error: 'Missing SKILL.md',
    }, pluginBySkill);
  }

  try {
    const content = await fs.readFile(skillFile, 'utf-8');
    const frontmatterRaw = extractFrontmatter(content);
    if (!frontmatterRaw) {
      return withPluginMetadata({ id: skillId, name: skillId, valid: true, warning: 'No frontmatter' }, pluginBySkill);
    }

    const frontmatter = parseYaml(frontmatterRaw) as { name?: string; description?: string } | null;
    return withPluginMetadata({
      id: skillId,
      name: frontmatter?.name?.toString() || skillId,
      description: frontmatter?.description?.toString() || '',
      valid: true,
    }, pluginBySkill);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to parse SKILL.md';
    return withPluginMetadata({ id: skillId, name: skillId, valid: false, error: message }, pluginBySkill);
  }
}
