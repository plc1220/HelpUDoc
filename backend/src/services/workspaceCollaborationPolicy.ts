import type { WorkspaceRole } from './workspaceService';

export type WorkspaceCollaborationObjectType =
  | 'annotation'
  | 'sticky_note'
  | 'task'
  | 'change_proposal';

export type WorkspaceCollaborationVisibility = 'private' | 'workspace_audience';

export type WorkspaceRoleCapabilities = {
  canView: boolean;
  canComment: boolean;
  canPropose: boolean;
  canPublish: boolean;
  canManageAccess: boolean;
};

const CAPABILITIES: Record<WorkspaceRole, WorkspaceRoleCapabilities> = {
  viewer: {
    canView: true,
    canComment: false,
    canPropose: false,
    canPublish: false,
    canManageAccess: false,
  },
  commenter: {
    canView: true,
    canComment: true,
    canPropose: false,
    canPublish: false,
    canManageAccess: false,
  },
  contributor: {
    canView: true,
    canComment: true,
    canPropose: true,
    canPublish: false,
    canManageAccess: false,
  },
  editor: {
    canView: true,
    canComment: true,
    canPropose: true,
    canPublish: true,
    canManageAccess: false,
  },
  owner: {
    canView: true,
    canComment: true,
    canPropose: true,
    canPublish: true,
    canManageAccess: true,
  },
};

export const getWorkspaceRoleCapabilities = (role: WorkspaceRole): WorkspaceRoleCapabilities =>
  CAPABILITIES[role];

export const canCreateWorkspaceCollaborationObject = (
  role: WorkspaceRole,
  type: WorkspaceCollaborationObjectType,
  visibility: WorkspaceCollaborationVisibility,
): boolean => {
  if (type === 'change_proposal') {
    return getWorkspaceRoleCapabilities(role).canPropose;
  }
  if (visibility === 'private') {
    return getWorkspaceRoleCapabilities(role).canView;
  }
  return getWorkspaceRoleCapabilities(role).canComment;
};

export const canModerateWorkspaceCollaboration = (role: WorkspaceRole): boolean =>
  role === 'owner' || role === 'editor';
