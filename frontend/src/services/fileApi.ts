import { API_URL, apiFetch } from './apiClient';

export const getFiles = async (workspaceId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files`);
  if (!response.ok) {
    throw new Error('Failed to fetch files');
  }
  return response.json();
};

export const getFileContent = async (workspaceId: string, fileId: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/${fileId}/content`);
  if (!response.ok) {
    throw new Error('Failed to fetch file content');
  }
  return response.json();
};

export const getWorkspaceFilePreview = async (workspaceId: string, relativePath: string) => {
  const url = new URL(`${API_URL}/workspaces/${workspaceId}/files/preview`);
  url.searchParams.set('path', relativePath);
  const response = await apiFetch(url.toString());
  if (!response.ok) {
    throw new Error('Failed to preview file');
  }
  return response.json();
};

export const createFile = async (workspaceId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    throw new Error('Failed to create file');
  }
  return response.json();
};

export const updateFileContent = async (
  workspaceId: string,
  fileId: number,
  content: string,
) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}/content`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    throw new Error('Failed to update file content');
  }
  return response.json();
};

export const deleteFile = async (workspaceId: string, fileId: string) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'DELETE',
    },
  );
  if (!response.ok) {
    throw new Error('Failed to delete file');
  }
};

export const renameFile = async (workspaceId: string, fileId: string, name: string) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!response.ok) {
    throw new Error('Failed to rename file');
  }
  return response.json();
};

export const getRagStatuses = async (workspaceId: string, files: string[]) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/rag-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files }),
  });
  if (!response.ok) {
    throw new Error('Failed to fetch RAG status');
  }
  return response.json();
};
