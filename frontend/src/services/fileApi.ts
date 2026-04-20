import { API_URL, apiFetch, buildApiUrl } from './apiClient';
import type {
  FileContextRef,
  GoogleDrivePickerScope,
  GoogleDriveSearchResult,
} from '../types';

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
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview`);
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

export const createTextFile = async (
  workspaceId: string,
  payload: { name: string; content: string; mimeType?: string },
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error('Failed to create text file');
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

export const deleteFolder = async (workspaceId: string, folderPath: string) => {
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/folders`);
  url.searchParams.set('path', folderPath);
  const response = await apiFetch(url.toString(), {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete folder');
  }
};

export const renameFile = async (
  workspaceId: string,
  fileId: string,
  payload: { name?: string; path?: string; version?: number },
) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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

export const searchGoogleDriveFiles = async (
  workspaceId: string,
  params: { query?: string; scope?: GoogleDrivePickerScope; pageToken?: string },
): Promise<GoogleDriveSearchResult> => {
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/drive/search`);
  if (params.query?.trim()) {
    url.searchParams.set('query', params.query.trim());
  }
  if (params.scope) {
    url.searchParams.set('scope', params.scope);
  }
  if (params.pageToken?.trim()) {
    url.searchParams.set('pageToken', params.pageToken.trim());
  }
  const response = await apiFetch(url.toString());
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to search Google Drive',
    );
  }
  return response.json();
};

export const importGoogleDriveFiles = async (
  workspaceId: string,
  fileIds: string[],
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/drive/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fileIds }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to import Google Drive files',
    );
  }
  return response.json();
};

export const resolveFileContextRefs = async (
  workspaceId: string,
  fileIds: number[],
): Promise<{ fileContextRefs: FileContextRef[] }> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/context`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fileIds }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to prepare attached files',
    );
  }
  return response.json();
};
