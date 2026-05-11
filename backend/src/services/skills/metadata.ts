import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import { extractFrontmatter } from './frontmatter';
import { pathExists } from './registry';
import { resolveSkillDir } from './paths';

export type SkillMetadata = {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
};

export async function getSkillMetadata(skillId: string): Promise<SkillMetadata> {
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
