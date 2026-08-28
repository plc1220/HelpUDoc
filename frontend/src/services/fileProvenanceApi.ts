import { API_URL, apiFetch } from './apiClient';
import type {
  FileAuditEvent,
  FileProvenanceDocument,
  FileStatus,
  FileStatusState,
  FileStatusTransitionRequest,
  WorkspaceFileStatusSummary,
} from '../types';

/**
 * Reads a file's history and drives its editorial status.
 *
 * The server decides which transitions are permitted; `allowedTransitions` on
 * the status response is what the UI renders, so a role change takes effect
 * without shipping new frontend logic.
 */

const apiError = async (response: Response, fallback: string): Promise<never> => {
  const body = await response.json().catch(() => null);
  throw new Error(body?.error || fallback);
};

const jsonRequest = async <T>(
  url: string,
  init?: RequestInit,
  fallback = 'File provenance request failed',
): Promise<T> => {
  const response = await apiFetch(url, init);
  if (!response.ok) return apiError(response, fallback);
  return response.json() as Promise<T>;
};

const jsonBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const filesUrl = (workspaceId: string, fileId: number | string) =>
  `${API_URL}/workspaces/${workspaceId}/files/${fileId}`;

// --- history ---------------------------------------------------------------

export const fetchFileProvenance = (workspaceId: string, fileId: number | string) =>
  jsonRequest<FileProvenanceDocument>(
    `${filesUrl(workspaceId, fileId)}/provenance`,
    undefined,
    'Failed to load file history',
  );

export const fetchFileAuditEvents = (
  workspaceId: string,
  fileId: number | string,
  options?: { cursor?: number; limit?: number },
) => {
  const params = new URLSearchParams();
  if (options?.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  return jsonRequest<{ events: FileAuditEvent[]; nextCursor: number | null }>(
    `${filesUrl(workspaceId, fileId)}/audit-events${query ? `?${query}` : ''}`,
    undefined,
    'Failed to load file events',
  );
};

export type FileProvenanceVerification = {
  fileId: number;
  valid: boolean;
  brokenAtSeq: number | null;
  eventCount: number;
  chainHead: string | null;
  priorChain?: { workspaceId: string; fileId: number; valid: boolean; brokenAtSeq: number | null };
};

export const verifyFileProvenance = (workspaceId: string, fileId: number | string) =>
  jsonRequest<FileProvenanceVerification>(
    `${filesUrl(workspaceId, fileId)}/provenance/verify`,
    undefined,
    'Failed to verify file history',
  );

export const fileProvenanceDownloadUrl = (workspaceId: string, fileId: number | string) =>
  `${filesUrl(workspaceId, fileId)}/provenance/download`;

// --- status ----------------------------------------------------------------

export const fetchFileStatus = (workspaceId: string, fileId: number | string) =>
  jsonRequest<FileStatusState>(
    `${filesUrl(workspaceId, fileId)}/status`,
    undefined,
    'Failed to load file status',
  );

export const changeFileStatus = (
  workspaceId: string,
  fileId: number | string,
  request: FileStatusTransitionRequest,
) =>
  jsonRequest<FileStatusState>(
    `${filesUrl(workspaceId, fileId)}/status`,
    jsonBody('POST', request),
    'Failed to change file status',
  );

export const fetchWorkspaceStatusSummary = (workspaceId: string) =>
  jsonRequest<WorkspaceFileStatusSummary>(
    `${API_URL}/workspaces/${workspaceId}/files/status-summary`,
    undefined,
    'Failed to load status summary',
  );

// --- publications ----------------------------------------------------------

export type FilePublication = {
  id: string;
  fileId: number;
  publicationVersion: number;
  sourcePath: string;
  publishedName: string;
  targetUri: string;
  sha256: string;
  sizeBytes: number;
  sourceFileVersion: number;
  publishedByUserId?: string | null;
  publishedAt: string;
  withdrawnAt?: string | null;
};

export const fetchFilePublications = (workspaceId: string, fileId: number | string) =>
  jsonRequest<{ publications: FilePublication[] }>(
    `${filesUrl(workspaceId, fileId)}/publications`,
    undefined,
    'Failed to load publications',
  ).then((body) => body.publications ?? []);

export const publicationDownloadUrl = (
  workspaceId: string,
  fileId: number | string,
  publicationVersion: number,
) => `${filesUrl(workspaceId, fileId)}/publications/${publicationVersion}/download`;

// --- presentation ----------------------------------------------------------

export const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  published: 'Published',
};

/** Lifecycle order, used to render the full set of statuses in a menu. */
export const FILE_STATUS_ORDER: FileStatus[] = ['draft', 'in_review', 'approved', 'published'];

/** StatusDot has no purple, so published borrows accent. */
export const FILE_STATUS_DOT: Record<FileStatus, 'neutral' | 'warning' | 'success' | 'accent'> = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  published: 'accent',
};
