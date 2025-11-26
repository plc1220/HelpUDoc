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


export const createWorkspace = async (name: string) => {
  const response = await apiFetch(`${API_URL}/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error('Failed to create workspace');
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
