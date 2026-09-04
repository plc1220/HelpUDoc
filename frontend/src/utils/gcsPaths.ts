import type { GcsBrowseEntry } from '../types';

/**
 * Path helpers for the Cloud Storage picker. Object keys are flat strings with
 * '/' as a convention, so every notion of a "folder" is derived here rather than
 * in the component, which keeps it testable.
 */

/** '' for the bucket root, otherwise a key prefix ending in exactly one '/'. */
export const normalizeGcsPrefix = (value: string | null | undefined): string => {
  const raw = String(value || '').trim().replace(/^\/+/, '');
  if (!raw) {
    return '';
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
};

/** The prefix one level up, or '' at the root. */
export const parentGcsPrefix = (prefix: string): string => {
  const normalized = normalizeGcsPrefix(prefix);
  if (!normalized) {
    return '';
  }
  const segments = normalized.slice(0, -1).split('/');
  segments.pop();
  return segments.length ? `${segments.join('/')}/` : '';
};

/**
 * Breadcrumb trail for a prefix, relative to `rootPrefix`. The registration's
 * own prefix is the root of the picker, so a bucket confined to `exports/` shows
 * the bucket name rather than an `exports` crumb the user cannot navigate above.
 */
export const gcsBreadcrumbs = (
  prefix: string,
  rootPrefix = '',
): Array<{ label: string; prefix: string }> => {
  const root = normalizeGcsPrefix(rootPrefix);
  const normalized = normalizeGcsPrefix(prefix);
  const relative = normalized.startsWith(root) ? normalized.slice(root.length) : '';
  if (!relative) {
    return [];
  }
  const segments = relative.slice(0, -1).split('/').filter(Boolean);
  return segments.map((label, index) => ({
    label,
    prefix: `${root}${segments.slice(0, index + 1).join('/')}/`,
  }));
};

/** Leaf label for an object key or folder prefix. */
export const gcsLeafName = (objectPath: string): string => {
  const trimmed = objectPath.endsWith('/') ? objectPath.slice(0, -1) : objectPath;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
};

/** Folders first, then objects, each alphabetically — the order a file tree uses. */
export const sortGcsEntries = (entries: GcsBrowseEntry[]): GcsBrowseEntry[] =>
  [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'prefix' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

export const formatGcsSize = (sizeBytes: number | null | undefined): string => {
  const bytes = Number(sizeBytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
};
