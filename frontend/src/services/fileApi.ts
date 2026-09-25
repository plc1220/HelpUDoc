import { API_URL, apiFetch, buildApiUrl } from './apiClient';
import { getAssociatedThreadId } from './teamThreadAssociation';
import type {
  GoogleDrivePickerScope,
  GoogleDriveSearchResult,
} from '../types';

/**
 * Release B (F6) provenance: resolve the thread id to stamp on a human file
 * mutation. An explicit `sourceThreadId` argument wins; otherwise we fall back
 * to the user's active per-user/workspace "attribute future edits" association
 * (see services/teamThreadAssociation.ts). When there is no association the
 * result is undefined and the edit stays unattributed in workspace history —
 * the correct default. This is validated server-side; the client never invents
 * attribution and opening a thread never changes it.
 */
const resolveSourceThreadId = (
  workspaceId: string,
  explicit?: string,
): string | undefined => explicit ?? getAssociatedThreadId(workspaceId);

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

export const getFileDownloadUrl = (workspaceId: string, fileId: string | number, version?: number) => {
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/${fileId}/download`);
  if (version) url.searchParams.set('version', String(version));
  return url.toString();
};

export const getFilePreviewUrl = (workspaceId: string, fileId: string | number, version?: number) => {
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/${fileId}/preview`);
  if (version) url.searchParams.set('version', String(version));
  return url.toString();
};

export const getFileVersions = async (workspaceId: string, fileId: string | number) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/${fileId}/versions`);
  if (!response.ok) throw new Error('Failed to fetch file versions');
  const payload = await response.json();
  return Array.isArray(payload?.versions) ? payload.versions : [];
};

/**
 * Fetch the RAW source text of a specific immutable file version (by version
 * number) via the authenticated download endpoint. Used by the annotation
 * reattach flow so the user can select a NEW excerpt against the exact source
 * bytes (UTF-16 offsets on this text), rather than pretending rendered-markdown
 * offsets equal source bytes. Returns null when the bytes are not decodable as
 * text (binary), so the caller can show an honest "no source selection" state.
 */
export const getFileVersionText = async (
  workspaceId: string,
  fileId: string | number,
  version: number,
): Promise<{ text: string | null; contentType: string }> => {
  const response = await apiFetch(getFileDownloadUrl(workspaceId, fileId, version));
  if (!response.ok) throw new Error('Failed to fetch file version content');
  const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim();
  const buffer = await response.arrayBuffer();
  const textual = /^(text\/|application\/(json|xml|javascript|x-ndjson)|application\/.*\+(json|xml))/i.test(contentType);
  if (!textual) return { text: null, contentType: contentType || 'application/octet-stream' };
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), contentType };
};

export const restoreFileVersion = async (
  workspaceId: string,
  fileId: string | number,
  versionId: string,
  expectedVersion?: number,
  sourceThreadId?: string,
) => {
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}/versions/${versionId}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: expectedVersion, ...(threadId ? { sourceThreadId: threadId } : {}) }),
    },
  );
  if (!response.ok) throw new Error('Failed to restore file version');
  return response.json();
};

export const getWorkspaceFilePreview = async (workspaceId: string, relativePath: string) => {
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview`);
  url.searchParams.set('path', relativePath);
  const response = await apiFetch(url.toString());
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      if (payload && typeof payload === 'object' && typeof payload.error === 'string' && payload.error.trim()) {
        detail = payload.error.trim();
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(detail || `Failed to preview file (${response.status})`);
  }
  return response.json();
};

export const createFile = async (workspaceId: string, file: File, path?: string, sourceThreadId?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (path?.trim()) {
    formData.append('path', path.trim());
  }
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  if (threadId) {
    formData.append('sourceThreadId', threadId);
  }

  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      if (payload && typeof payload === 'object' && typeof payload.error === 'string' && payload.error.trim()) {
        detail = payload.error.trim();
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(detail || `Failed to create file (${response.status})`);
  }
  return response.json();
};

export const getFolders = async (workspaceId: string): Promise<string[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/folders`);
  if (!response.ok) {
    throw new Error('Failed to fetch folders');
  }
  const payload = await response.json();
  return Array.isArray(payload?.folders) ? payload.folders : [];
};

export const createFolder = async (workspaceId: string, path: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/folders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error('Failed to create folder');
  }
  return response.json();
};

export const createTextFile = async (
  workspaceId: string,
  payload: { name: string; content: string; mimeType?: string },
  sourceThreadId?: string,
) => {
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(threadId ? { ...payload, sourceThreadId: threadId } : payload),
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
  version?: number,
  strictVersion = false,
  sourceThreadId?: string,
) => {
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}/content`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, version, strictVersion, ...(threadId ? { sourceThreadId: threadId } : {}) }),
    },
  );
  if (!response.ok) {
    if (response.status === 409) throw new Error('This file has a newer revision. Refresh and preview again before applying.');
    throw new Error('Failed to update file content');
  }
  return response.json();
};

export const deleteFile = async (workspaceId: string, fileId: string, sourceThreadId?: string) => {
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/${fileId}`);
  if (threadId) {
    url.searchParams.set('sourceThreadId', threadId);
  }
  const response = await apiFetch(url.toString(), {
    method: 'DELETE',
  });
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

export const renameFolder = async (workspaceId: string, folderPath: string, name: string) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/folders`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: folderPath, name }),
  });
  if (!response.ok) {
    throw new Error('Failed to rename folder');
  }
  return response.json();
};

export const moveFolder = async (
  workspaceId: string,
  folderPath: string,
  destinationFolderPath: string,
) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/folders/move`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: folderPath, destinationPath: destinationFolderPath }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
        detail = payload.error;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new Error(detail || 'Failed to move folder');
  }
  return response.json();
};

export const renameFile = async (
  workspaceId: string,
  fileId: string,
  payload: { name?: string; path?: string; version?: number },
  sourceThreadId?: string,
) => {
  const threadId = resolveSourceThreadId(workspaceId, sourceThreadId);
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(threadId ? { ...payload, sourceThreadId: threadId } : payload),
    },
  );
  if (!response.ok) {
    throw new Error('Failed to rename file');
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
