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

export type KnowledgeBundleFileKind = 'index' | 'source' | 'concept' | 'log' | 'other';

export type KnowledgeBundleFile = {
  id: number;
  path: string;
  name: string;
  kind: KnowledgeBundleFileKind;
  mimeType?: string | null;
  updatedAt?: string | null;
};

export type KnowledgeBundleManifest = {
  knowledgeId: number;
  title: string;
  okfVersion: string;
  bundlePath: string;
  snapshotHash?: string | null;
  enrichmentMode?: string | null;
  coverage?: {
    discoveredSourceUnits: number;
    processedSourceUnits: number;
    failedSourceUnits: number;
    coveragePercent: number;
  };
  statistics?: {
    conceptCount: number;
    relationshipCount: number;
    structureNodeCount: number;
    processingWindowCount: number;
  };
  warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
  files: KnowledgeBundleFile[];
};

export type KnowledgeBundleFileContent = KnowledgeBundleFile & {
  content: string;
};

export type KnowledgeIngestionJob = {
  id: string;
  knowledgeId: number;
  status: string;
  stage: string;
  discoveredSourceUnits: number;
  processedSourceUnits: number;
  failedSourceUnits: number;
  coveragePercent: number;
  warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  progressPercent?: number;
  progressLabel?: string;
  sourceTitle?: string;
  sourceType?: string;
  sourceFileName?: string | null;
};

export type KnowledgeGraphSummary = {
  snapshotId: string | null;
  snapshotHash?: string;
  conceptCount: number;
  relationshipCount: number;
  communityCount: number;
  orphanCount: number;
  communities: Array<Record<string, unknown>>;
};

export type KnowledgeSnapshot = {
  id: string;
  runId: string;
  contentHash: string;
  bundlePath?: string | null;
  isPublished: boolean;
  publishedAt?: string | null;
  createdAt: string;
  status?: string | null;
  discoveredSourceUnits?: number;
  processedSourceUnits?: number;
  failedSourceUnits?: number;
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

export const getKnowledgeBundle = async (
  workspaceId: string,
  knowledgeId: number,
): Promise<KnowledgeBundleManifest> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/bundle`);
  return handleResponse(response);
};

export const getKnowledgeBundleFile = async (
  workspaceId: string,
  knowledgeId: number,
  path: string,
): Promise<KnowledgeBundleFileContent> => {
  const url = new URL(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/bundle/file`, window.location.origin);
  url.searchParams.set('path', path);
  const response = await apiFetch(url.toString());
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

export const getKnowledgeIngestion = async (
  workspaceId: string,
  knowledgeId: number,
): Promise<KnowledgeIngestionJob | null> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/ingestions/current`);
  return handleResponse(response);
};

export const getKnowledgeIngestionReport = async (workspaceId: string, knowledgeId: number, runId: string) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/ingestions/${runId}/report`,
  );
  return handleResponse(response);
};

export const cancelKnowledgeIngestion = async (workspaceId: string, knowledgeId: number, runId: string) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/ingestions/${runId}/cancel`,
    { method: 'POST' },
  );
  return handleResponse(response);
};

export const retryKnowledgeIngestion = async (workspaceId: string, knowledgeId: number, runId: string) => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/ingestions/${runId}/retry`,
    { method: 'POST' },
  );
  return handleResponse(response);
};

export const getKnowledgeGraph = async (
  workspaceId: string,
  knowledgeId: number,
): Promise<KnowledgeGraphSummary> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/knowledge/${knowledgeId}/graph`);
  return handleResponse(response);
};

export const listGlobalKnowledge = async () => {
  const response = await apiFetch(`${API_URL}/knowledge`);
  return handleResponse(response);
};

export const listGlobalKnowledgeIngestionJobs = async (): Promise<KnowledgeIngestionJob[]> => {
  const response = await apiFetch(`${API_URL}/knowledge/ingestions`);
  return handleResponse(response);
};

export const streamGlobalKnowledgeIngestionEvents = async (
  onEvent: (job: KnowledgeIngestionJob) => void,
  signal: AbortSignal,
): Promise<void> => {
  const response = await apiFetch(`${API_URL}/knowledge/ingestion-events`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error('Knowledge ingestion events are unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      if (!data) continue;
      try {
        const event = JSON.parse(data) as { job?: KnowledgeIngestionJob };
        if (event.job) onEvent(event.job);
      } catch {
        // The database polling loop is the fallback for malformed events.
      }
    }
  }
};

export const getGlobalKnowledgeBundle = async (knowledgeId: number): Promise<KnowledgeBundleManifest> => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/bundle`);
  return handleResponse(response);
};

export const getGlobalKnowledgeBundleFile = async (
  knowledgeId: number,
  path: string,
): Promise<KnowledgeBundleFileContent> => {
  const url = new URL(`${API_URL}/knowledge/${knowledgeId}/bundle/file`, window.location.origin);
  url.searchParams.set('path', path);
  const response = await apiFetch(url.toString());
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

export const getGlobalKnowledgeIngestion = async (knowledgeId: number): Promise<KnowledgeIngestionJob | null> => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/ingestions/current`);
  return handleResponse(response);
};

export const getGlobalKnowledgeIngestionReport = async (knowledgeId: number, runId: string) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/ingestions/${runId}/report`);
  return handleResponse(response);
};

export const cancelGlobalKnowledgeIngestion = async (knowledgeId: number, runId: string) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/ingestions/${runId}/cancel`, { method: 'POST' });
  return handleResponse(response);
};

export const retryGlobalKnowledgeIngestion = async (knowledgeId: number, runId: string) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/ingestions/${runId}/retry`, { method: 'POST' });
  return handleResponse(response);
};

export const getGlobalKnowledgeGraph = async (knowledgeId: number): Promise<KnowledgeGraphSummary> => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/graph`);
  return handleResponse(response);
};

export const listGlobalKnowledgeSnapshots = async (knowledgeId: number): Promise<KnowledgeSnapshot[]> => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/snapshots`);
  return handleResponse(response);
};

export const publishGlobalKnowledgeSnapshot = async (knowledgeId: number, snapshotId: string) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}/snapshots/${snapshotId}/publish`, {
    method: 'POST',
  });
  return handleResponse(response);
};

export const deleteGlobalKnowledge = async (knowledgeId: number) => {
  const response = await apiFetch(`${API_URL}/knowledge/${knowledgeId}`, { method: 'DELETE' });
  return handleResponse(response);
};
