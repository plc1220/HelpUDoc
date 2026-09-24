import { API_URL, apiFetch } from './apiClient';
import type { File } from '../types';
import type { OfficeDocument, OfficeEdit } from '../utils/officeQuickEdit';

export type OfficePreview = { pdf: string; revision: string; version: number | null; canEdit: boolean; document?: OfficeDocument };
export type OfficeSave = { file: File; previousVersion?: number; content?: string };

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(response.status === 409
      ? 'This document has changed. Refresh the preview before editing again.'
      : body.error || 'The document could not be processed. Please try again.');
  }
  return response.json();
}

export async function getOfficePreview(workspaceId: string, file: File, content: string, signal?: AbortSignal): Promise<OfficePreview> {
  const base = `${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/files`;
  if (/^\d+$/.test(String(file.id))) {
    return readResponse(await apiFetch(`${base}/${file.id}/office-preview`, { signal }));
  }
  return readResponse(await apiFetch(`${base}/office-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ filename: file.name, content }),
  }));
}

export async function applyOfficeEdit(workspaceId: string, fileId: string, preview: OfficePreview, edit: OfficeEdit): Promise<OfficeSave> {
  return readResponse(await apiFetch(`${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/files/${fileId}/quick-edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: preview.version, revision: preview.revision, edit }),
  }));
}

export async function undoOfficeEdit(workspaceId: string, fileId: string, version: number, restoreVersion: number): Promise<OfficeSave> {
  return readResponse(await apiFetch(`${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/files/${fileId}/quick-edit/undo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, restoreVersion }),
  }));
}
