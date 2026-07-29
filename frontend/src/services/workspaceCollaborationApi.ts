import { API_URL, apiFetch } from './apiClient';

export type WorkspaceCollaborationObjectType =
  | 'annotation'
  | 'sticky_note'
  | 'task'
  | 'change_proposal';

export type WorkspaceCollaborationStatus =
  | 'open'
  | 'discussing'
  | 'proposed'
  | 'resolved'
  | 'addressed'
  | 'anchor_changed';

export type WorkspaceCollaborationObject = {
  id: string;
  workspaceId: string;
  originVersionId: string | null;
  type: WorkspaceCollaborationObjectType;
  visibility: 'private' | 'workspace_audience';
  status: WorkspaceCollaborationStatus;
  filePath: string | null;
  title: string | null;
  body: string;
  authorId: string | null;
  authorName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  linkedPrivateWorkspaceId: string | null;
  resolvedByVersionId: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type WorkspaceCollaborationMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

const parseError = async (response: Response, fallback: string): Promise<never> => {
  const payload = await response.json().catch(() => ({}));
  throw new Error(typeof payload?.error === 'string' ? payload.error : fallback);
};

export const listWorkspaceCollaborationObjects = async (
  workspaceId: string,
): Promise<WorkspaceCollaborationObject[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaboration/objects`);
  if (!response.ok) {
    return parseError(response, 'Failed to load collaboration');
  }
  const payload = await response.json() as { objects?: WorkspaceCollaborationObject[] };
  return payload.objects || [];
};

export const getWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
): Promise<{
  object: WorkspaceCollaborationObject;
  messages: WorkspaceCollaborationMessage[];
}> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}`,
  );
  if (!response.ok) {
    return parseError(response, 'Failed to load collaboration item');
  }
  return response.json();
};

export const createWorkspaceCollaborationObject = async (
  workspaceId: string,
  payload: {
    type: WorkspaceCollaborationObjectType;
    visibility: 'private' | 'workspace_audience';
    title?: string;
    body: string;
    filePath?: string;
  },
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaboration/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return parseError(response, 'Failed to create collaboration item');
  }
  return response.json();
};

export const replyToWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
  body: string,
): Promise<void> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to post reply');
  }
};

export const updateWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
  payload: { status: WorkspaceCollaborationStatus },
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to update collaboration item');
  }
  return response.json();
};

export const convertWorkspaceCollaborationObjectToProposal = async (
  workspaceId: string,
  objectId: string,
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}/proposal`,
    { method: 'POST' },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to create proposal');
  }
  return response.json();
};
