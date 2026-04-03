export type UserMemoryScope = 'global' | 'workspace';
export type UserMemorySection = 'preferences' | 'context';

export const MEMORY_ROOT_PREFIX = '/memories';

export function buildUserMemoryPath(
  scope: UserMemoryScope,
  section: UserMemorySection,
  workspaceId?: string | null,
): string {
  if (scope === 'workspace') {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    if (!normalizedWorkspaceId) {
      throw new Error('workspaceId is required for workspace-scoped memory');
    }
    return `${MEMORY_ROOT_PREFIX}/workspaces/${normalizedWorkspaceId}/${section}.md`;
  }
  return `${MEMORY_ROOT_PREFIX}/global/${section}.md`;
}

export function describeUserMemoryPath(path: string): {
  scope: UserMemoryScope;
  section: UserMemorySection;
  workspaceId?: string;
} {
  const normalized = String(path || '').trim().replace(/\\/g, '/');
  const globalMatch = normalized.match(/^\/memories\/global\/(preferences|context)\.md$/);
  if (globalMatch) {
    return {
      scope: 'global',
      section: globalMatch[1] as UserMemorySection,
    };
  }

  const workspaceMatch = normalized.match(/^\/memories\/workspaces\/([^/]+)\/(preferences|context)\.md$/);
  if (workspaceMatch) {
    return {
      scope: 'workspace',
      workspaceId: workspaceMatch[1],
      section: workspaceMatch[2] as UserMemorySection,
    };
  }

  throw new Error('Unsupported memory path');
}

export function emptyUserMemoryView() {
  return {
    globalPreferences: '',
    globalContext: '',
    workspacePreferences: '',
    workspaceContext: '',
  };
}
