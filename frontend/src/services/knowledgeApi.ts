import { API_URL, apiFetch } from './apiClient';

const handleResponse = async (response: Response) => {
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    const message = data?.error || 'Request failed';
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
};

export const listKnowledge = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge`);
  return handleResponse(response);
};

export const getKnowledge = async (workspaceId: string, knowledgeId: number | string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}`);
  return handleResponse(response);
};

export const createKnowledge = async (
  workspaceId: string,
  payload: {
    title: string;
    type: 'text' | 'table' | 'image' | 'presentation' | 'infographic';
    description?: string;
    content?: string;
    fileId?: number;
    sourceUrl?: string;
    tags?: any;
    metadata?: Record<string, any>;
  },
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
};

export const updateKnowledge = async (
  workspaceId: string,
  knowledgeId: number,
  payload: Partial<{
    title: string;
    type: 'text' | 'table' | 'image' | 'presentation' | 'infographic';
    description?: string;
    content?: string;
    fileId?: number | null;
    sourceUrl?: string;
    tags?: any;
    metadata?: Record<string, any>;
  }>,
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
};

export const deleteKnowledge = async (workspaceId: string, knowledgeId: number) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}`, {
    method: 'DELETE',
  });
  return handleResponse(response);
};
