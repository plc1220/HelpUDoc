import path from 'path';
import { existsSync } from 'fs';

/** Repository root (parent of `backend/`) */
export const repoRoot = path.resolve(__dirname, '../../../..');

function resolveRepoRelativePath(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
}

export const skillsRoot = resolveRepoRelativePath(process.env.SKILLS_ROOT) || path.join(repoRoot, 'skills');
export const pluginsRoot = resolveRepoRelativePath(process.env.PLUGINS_ROOT) || path.join(repoRoot, 'plugins');

/**
 * Whether a user's own private skill draft may run in their private workspaces.
 * Turning this off stops the runtime from seeing draft pins; it leaves the pin
 * rows in place, so an operator can disable the feature without destroying
 * anybody's work.
 */
export const privateSkillRuntimeEnabled = () =>
  String(process.env.ENABLE_PRIVATE_SKILL_RUNTIME ?? 'true').toLowerCase() !== 'false';
