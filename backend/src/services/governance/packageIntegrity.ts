import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

type ManifestEntry = {
  path: string;
  contentHash: string;
  mode: number;
  sizeBytes: number;
};

/**
 * Recompute a materialized package's manifest hash from the bytes on disk.
 *
 * This mirrors the agent's `_compute_governed_manifest_hash` (Python) exactly, because that is the
 * function which decides whether a signed version pin is honoured at runtime. Verifying integrity
 * with `computePackageManifestHash` over `skill_version_files` instead would be circular: those
 * rows produced the stored digest, so they always agree with it even when the package on disk has
 * drifted.
 *
 * Contract points that must stay identical across the two languages:
 *   - entries sorted by POSIX path in **byte order**, never locale collation
 *   - key order `path, contentHash, mode, sizeBytes`
 *   - compact JSON separators, non-ASCII left unescaped
 *   - any symlink invalidates the package
 *
 * Returns `null` when the package cannot be hashed (missing, unreadable, or containing a symlink),
 * which callers must treat as "not loadable" rather than "unchanged".
 */
export const computeOnDiskManifestHash = async (packageRoot: string): Promise<string | null> => {
  const entries: ManifestEntry[] = [];

  const walk = async (current: string): Promise<boolean> => {
    const dirents = await fs.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = path.join(current, dirent.name);
      if (dirent.isSymbolicLink()) {
        return false;
      }
      if (dirent.isDirectory()) {
        if (!await walk(absolute)) return false;
        continue;
      }
      if (!dirent.isFile()) continue;
      const content = await fs.readFile(absolute);
      const stat = await fs.stat(absolute);
      entries.push({
        path: path.relative(packageRoot, absolute).split(path.sep).join('/'),
        contentHash: crypto.createHash('sha256').update(content).digest('hex'),
        mode: stat.mode & 0o777,
        sizeBytes: content.length,
      });
    }
    return true;
  };

  try {
    if (!await walk(packageRoot)) return null;
  } catch {
    return null;
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
};
