import path from 'path';
import { skillsRoot } from './constants';

export const ACTION_ALLOWED_PREFIXES = ['SKILL.md', 'scripts/', 'references/', 'assets/', 'templates/'];
export const IMPORT_ALLOWED_PREFIXES = [
  'SKILL.md',
  'scripts/',
  'references/',
  'assets/',
  'templates/',
  'docs/',
  'examples/',
];

export const IMPORT_BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com']);

export const isValidSkillId = (id: string) => /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(id);

export const normalizeSkillId = (id: string) => id.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export function resolveSkillDir(id: string): string {
  const normalizedId = normalizeSkillId(id);
  if (!isValidSkillId(normalizedId)) {
    throw new Error('Invalid skill id');
  }
  return path.join(skillsRoot, normalizedId);
}

export function isAllowedActionPath(relativePath: string, prefixes = ACTION_ALLOWED_PREFIXES): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized === 'SKILL.md') return true;
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function resolveSkillFile(
  id: string,
  relativePath: string,
  prefixes = ACTION_ALLOWED_PREFIXES,
): string {
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
