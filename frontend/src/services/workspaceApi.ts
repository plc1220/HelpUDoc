import { API_URL, apiFetch } from './apiClient';

export class WorkspaceApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.details = details;
  }
}

const throwWorkspaceApiError = async (response: Response, fallback: string): Promise<never> => {
  const payload = await response.json().catch(() => ({}));
  throw new WorkspaceApiError(
    typeof payload?.error === 'string' ? payload.error : fallback,
    response.status,
    payload?.details,
  );
};

export const getWorkspaces = async () => {
  const response = await apiFetch(`${API_URL}/workspaces`);
  if (!response.ok) {
    throw new Error('Failed to fetch workspaces');
  }
  return response.json();
};
export const getWorkspace = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch workspace');
  }
  return response.json();
};

export const createWorkspace = async (name?: string) => {
  const response = await apiFetch(`${API_URL}/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(name !== undefined ? { name } : {}),
  });
  if (!response.ok) {
    throw new Error('Failed to create workspace');
  }
  return response.json();
};

export const renameWorkspace = async (workspaceId: string, name: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error('Failed to rename workspace');
  }
  return response.json();
};

export const deleteWorkspace = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete workspace');
  }
};

export type DirectoryUser = {
  id: string;
  displayName: string;
  email: string | null;
};

export type WorkspaceCollaborator = {
  userId: string;
  displayName: string;
  role: 'owner' | 'editor' | 'contributor' | 'commenter' | 'viewer';
  canEdit: boolean;
};

export const fetchUserDirectory = async (query: string, limit = 20) => {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    excludeSelf: 'true',
  });
  const response = await apiFetch(`${API_URL}/workspaces/user-directory?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to search users');
  }
  const data = (await response.json()) as { users: DirectoryUser[] };
  return data.users ?? [];
};

export const listWorkspaceCollaborators = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaborators`);
  if (!response.ok) {
    throw new Error('Failed to list collaborators');
  }
  const data = (await response.json()) as { collaborators: WorkspaceCollaborator[] };
  return data.collaborators ?? [];
};

export const addWorkspaceCollaborator = async (
  workspaceId: string,
  payload: { userId: string; role: 'editor' | 'contributor' | 'commenter' | 'viewer' },
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(typeof err?.error === 'string' ? err.error : 'Failed to add collaborator');
  }
};

export const removeWorkspaceCollaborator = async (workspaceId: string, targetUserId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaborators/${targetUserId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(typeof err?.error === 'string' ? err.error : 'Failed to remove collaborator');
  }
};

export type WorkspaceTeam = {
  id: string;
  name: string;
};

export type PublicationConflict = {
  path: string;
  privateChange: 'added' | 'changed' | 'deleted';
  teamChange: 'added' | 'changed' | 'deleted';
  privateText?: string;
  teamText?: string;
  textTruncated?: boolean;
};

export type PublishedWorkspaceVersion = {
  id: string;
  versionNumber: number;
  note: string | null;
  createdAt: string;
  publisherName: string;
};

export const listWorkspaceTeams = async (): Promise<WorkspaceTeam[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/teams`);
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to list teams');
  }
  const payload = await response.json() as { teams?: WorkspaceTeam[] };
  return payload.teams || [];
};

export const publishWorkspace = async (
  workspaceId: string,
  payload: { teamId?: string; name?: string; note?: string },
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to publish workspace');
  }
  return response.json() as Promise<{
    teamWorkspaceId: string;
    privateWorkspaceId: string;
    publishedVersionId: string;
    publishedVersionNumber: number;
    publishedAt: string;
  }>;
};

export const createPrivateWorkspaceCopy = async (teamWorkspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${teamWorkspaceId}/private-copy`, {
    method: 'POST',
  });
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to create private working copy');
  }
  return response.json();
};

export const syncWorkspaceWithTeam = async (
  privateWorkspaceId: string,
  resolutions: Record<string, 'private' | 'team'> = {},
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${privateWorkspaceId}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions }),
  });
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to sync team updates');
  }
  return response.json();
};

export const listPublishedWorkspaceHistory = async (
  teamWorkspaceId: string,
): Promise<PublishedWorkspaceVersion[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/${teamWorkspaceId}/history`);
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to load publication history');
  }
  const payload = await response.json() as { versions?: PublishedWorkspaceVersion[] };
  return payload.versions || [];
};

export const restorePublishedWorkspaceVersion = async (
  teamWorkspaceId: string,
  versionId: string,
) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${teamWorkspaceId}/versions/${versionId}/restore`,
    { method: 'POST' },
  );
  if (!response.ok) {
    return throwWorkspaceApiError(response, 'Failed to restore published version');
  }
  return response.json();
};
