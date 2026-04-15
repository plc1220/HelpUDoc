import { API_URL, apiFetch } from './apiClient';

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

export const getWorkspaceSettings = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/settings`);
  if (!response.ok) {
    throw new Error('Failed to fetch workspace settings');
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

export const updateWorkspaceSettings = async (
  workspaceId: string,
  payload: { skipPlanApprovals: boolean },
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error('Failed to update workspace settings');
  }
  return response.json();
};

export type DirectoryUser = {
  id: string;
  displayName: string;
  email: string | null;
};

export type WorkspaceCollaborator = {
  userId: string;
  displayName: string;
  role: 'owner' | 'editor' | 'viewer';
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
  payload: { userId: string; role: 'editor' | 'viewer' },
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
