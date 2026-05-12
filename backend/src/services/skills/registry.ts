import path from 'path';
import { promises as fs } from 'fs';

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively list skill package ids (directories containing SKILL.md) under a registry root.
 */
export async function collectSkillIds(rootDir: string, relativeDir = ''): Promise<string[]> {
  const currentDir = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  let ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relPath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    const fullPath = path.join(currentDir, entry.name);
    const skillFile = path.join(fullPath, 'SKILL.md');
    if (await pathExists(skillFile)) {
      ids.push(relPath);
    }
    ids = ids.concat(await collectSkillIds(rootDir, relPath));
  }

  return ids.sort((a, b) => a.localeCompare(b));
}
