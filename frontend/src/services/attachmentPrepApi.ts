import { API_URL, apiFetch } from './apiClient';
import type { File as WorkspaceFile, FileContextRef, AttachmentPrepStatus } from '../types';

export type AttachmentPrepJob = {
  id: string;
  workspaceId: string;
  conversationId: string;
  turnId: string;
  status: AttachmentPrepStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    files: WorkspaceFile[];
    fileContextRefs: FileContextRef[];
    multimodalFileIds: number[];
  };
};

const readAttachmentPrepError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object' && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Ignore non-JSON responses.
  }
  return fallback;
};

export const createAttachmentPrepJob = async (
  workspaceId: string,
  payload: {
    conversationId: string;
    turnId: string;
    driveFileIds?: string[];
    sourceFileIds?: number[];
  },
): Promise<AttachmentPrepJob> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/attachments/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readAttachmentPrepError(response, 'Failed to prepare attachments'));
  }
  return response.json();
};

export const getAttachmentPrepJob = async (
  workspaceId: string,
  jobId: string,
): Promise<AttachmentPrepJob> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/attachments/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(await readAttachmentPrepError(response, 'Failed to load attachment prep status'));
  }
  return response.json();
};
