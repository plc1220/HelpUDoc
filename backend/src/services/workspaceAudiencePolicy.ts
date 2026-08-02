import type { WorkspaceRole } from './workspaceService';

export type WorkspaceNamedGrantRole = 'publisher' | 'contributor' | 'viewer';

export const normalizeSelectedWorkspaceUsers = (
  ownerUserId: string,
  userIds: string[] = [],
): string[] => Array.from(new Set(
  userIds
    .map((userId) => String(userId || '').trim())
    .filter((userId) => userId && userId !== ownerUserId),
));

export const namedGrantToLegacyWorkspaceRole = (
  role: WorkspaceNamedGrantRole,
): WorkspaceRole => {
  if (role === 'publisher') return 'editor';
  return role;
};

export const legacyWorkspaceRoleToNamedGrant = (
  role: WorkspaceRole,
): WorkspaceNamedGrantRole => {
  if (role === 'editor') return 'publisher';
  if (role === 'contributor') return 'contributor';
  return 'viewer';
};
