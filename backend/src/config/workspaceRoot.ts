import path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_WORKSPACE_ROOT = path.join(REPO_ROOT, 'backend', 'workspaces');
const LOCAL_DEV_ENVIRONMENTS = new Set(['', 'development', 'test']);
const SUSPICIOUS_LOCAL_PATHS = new Set([
  path.resolve(REPO_ROOT, 'backend', 'backend', 'workspaces'),
  path.resolve(REPO_ROOT, 'agent', 'backend', 'workspaces'),
]);

export type WorkspaceRootDiagnostic = {
  rawValue: string | null;
  resolvedPath: string;
  source: 'env' | 'default';
  repoRoot: string;
  isLocalDev: boolean;
};

function isLocalDevEnvironment(): boolean {
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return LOCAL_DEV_ENVIRONMENTS.has(env);
}

function assertWorkspaceRootLooksSane(rawValue: string | null, resolvedPath: string): void {
  if (!isLocalDevEnvironment()) {
    return;
  }

  if (rawValue && !path.isAbsolute(rawValue)) {
    const relativeTarget = path.relative(REPO_ROOT, resolvedPath);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error(
        `Relative WORKSPACE_ROOT must stay within the repo in local/dev. ` +
        `Got raw="${rawValue}" resolved="${resolvedPath}".`,
      );
    }
  }

  if (SUSPICIOUS_LOCAL_PATHS.has(resolvedPath)) {
    throw new Error(
      `Resolved WORKSPACE_ROOT looks inconsistent for local/dev: "${resolvedPath}". ` +
      `Use a repo-root-relative path such as "backend/workspaces" or an absolute shared path.`,
    );
  }
}

export function getWorkspaceRootDiagnostic(rawOverride = process.env.WORKSPACE_ROOT): WorkspaceRootDiagnostic {
  const rawValue = String(rawOverride || '').trim() || null;
  const resolvedPath = rawValue
    ? path.resolve(path.isAbsolute(rawValue) ? rawValue : path.join(REPO_ROOT, rawValue))
    : DEFAULT_WORKSPACE_ROOT;

  assertWorkspaceRootLooksSane(rawValue, resolvedPath);

  return {
    rawValue,
    resolvedPath,
    source: rawValue ? 'env' : 'default',
    repoRoot: REPO_ROOT,
    isLocalDev: isLocalDevEnvironment(),
  };
}

export function resolveWorkspaceRoot(rawOverride = process.env.WORKSPACE_ROOT): string {
  return getWorkspaceRootDiagnostic(rawOverride).resolvedPath;
}

export function logWorkspaceRootDiagnostic(label: string): string {
  const diagnostic = getWorkspaceRootDiagnostic();
  const rawSuffix = diagnostic.rawValue ? ` raw=${diagnostic.rawValue}` : '';
  console.log(
    `[${label}] Workspace root: ${diagnostic.resolvedPath} ` +
    `(source=${diagnostic.source}${rawSuffix})`,
  );
  return diagnostic.resolvedPath;
}
