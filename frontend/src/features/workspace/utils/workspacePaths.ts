import type { File as WorkspaceFile } from '../../../types';

/**
 * Normalize a workspace-relative path string for comparison and storage.
 * - Converts backslashes to forward slashes
 * - Strips leading slashes
 * - Trims whitespace
 */
export const normalizeWorkspaceRelativePath = (value?: string | null): string =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

/** Build the manifest path (`<dashboard>/dashboard.meta.json`) for a dashboard package path. */
export const getDashboardManifestPath = (dashboardPath?: string | null) => {
  const normalized = normalizeWorkspaceRelativePath(dashboardPath);
  return normalized ? `${normalized}/dashboard.meta.json` : '';
};

/** Recover the dashboard package directory from a manifest file path. */
export const getDashboardPackagePathFromManifestPath = (manifestPath?: string | null) => {
  const normalized = normalizeWorkspaceRelativePath(manifestPath);
  if (!normalized.endsWith('/dashboard.meta.json')) {
    return '';
  }
  return normalized.slice(0, -'/dashboard.meta.json'.length);
};

/**
 * Resolve the canonical dashboard package path for a workspace, given a candidate path.
 * Falls back to a single descendant manifest when the direct manifest is missing.
 */
export const resolveDashboardPackagePath = (
  files: WorkspaceFile[],
  dashboardPath?: string | null,
) => {
  const normalized = normalizeWorkspaceRelativePath(dashboardPath);
  if (!normalized) {
    return '';
  }
  const exactManifestPath = getDashboardManifestPath(normalized);
  if (files.some((file) => normalizeWorkspaceRelativePath(file.path || file.name) === exactManifestPath)) {
    return normalized;
  }
  const descendantPackagePaths = new Set(
    files
      .map((file) => normalizeWorkspaceRelativePath(file.path || file.name))
      .filter((path) => path.startsWith(`${normalized}/`) && path.endsWith('/dashboard.meta.json'))
      .map((path) => getDashboardPackagePathFromManifestPath(path))
      .filter(Boolean),
  );
  if (descendantPackagePaths.size === 1) {
    return Array.from(descendantPackagePaths)[0];
  }
  return normalized;
};
