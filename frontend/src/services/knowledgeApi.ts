import { API_URL, apiFetch } from './apiClient';

type KnowledgePayload = {
  title: string;
  type: 'text' | 'table' | 'image' | 'presentation' | 'infographic';
  description?: string;
  content?: string;
  fileId?: number;
  sourceUrl?: string;
  tags?: unknown;
  metadata?: Record<string, unknown>;
};

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
    tags?: unknown;
    metadata?: Record<string, unknown>;
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
    tags?: unknown;
    metadata?: Record<string, unknown>;
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

export const rebuildKnowledge = async (workspaceId: string, knowledgeId: number) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/ingest`,
    { method: 'POST' },
  );
  return handleResponse(response);
};

export const listGlobalKnowledge = async () => {
  const response = await apiFetch(`${API_URL}/knowledge`);
  return handleResponse(response);
};

export const uploadGlobalKnowledge = async (
  file: File,
  payload: Pick<KnowledgePayload, 'title' | 'type' | 'description' | 'metadata'>,
) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', payload.title);
  formData.append('type', payload.type);
  if (payload.description) formData.append('description', payload.description);
  if (payload.metadata) formData.append('metadata', JSON.stringify(payload.metadata));
  const response = await apiFetch(`${API_URL}/knowledge/upload`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse(response);
};

export const rebuildGlobalKnowledge = async (knowledgeId: number) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/ingest`, { method: 'POST' });
  return handleResponse(response);
};

export const deleteGlobalKnowledge = async (knowledgeId: number) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}`, { method: 'DELETE' });
  return handleResponse(response);
};
