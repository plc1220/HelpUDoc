import { API_URL, apiFetch } from './apiClient';
import type {
  KnowledgeUploadSession,
  KnowledgeBundleManifest,
  KnowledgeBundleFileContent,
  KnowledgeGraphSummary,
  KnowledgeSnapshot,
} from './knowledgeApi';

export type KnowledgeBaseStatus = 'draft' | 'published' | 'archived';

export type KnowledgeBaseSummary = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  ownerTeamId?: string | null;
  ownerTeamName?: string | null;
  status: KnowledgeBaseStatus;
  currentVersion?: string | null;
  isDefault: boolean;
  sourceCount: number;
  teamGrantCount: number;
  available?: boolean;
};

export type KnowledgeBaseMember = {
  knowledgeSourceId: number;
  title: string;
  type: string;
  snapshotHash?: string | null;
  published: boolean;
  addedSincePublish: boolean;
  changedSincePublish: boolean;
  ingestionStatus?: string | null;
  ingestionStage?: string | null;
  coveragePercent?: number | null;
};

export type KnowledgeBaseDetail = KnowledgeBaseSummary & {
  members: KnowledgeBaseMember[];
  hasUnpublishedChanges: boolean;
  permissions: { canManage: boolean };
};

export type KnowledgeBaseVersionEntry = {
  id: string;
  version: string;
  note?: string | null;
  publishedByUserId?: string | null;
  publishedAt: string;
  sourceCount: number;
  changes: { added: string[]; updated: string[]; removed: string[] };
  isCurrent: boolean;
};

export type KnowledgeBaseTeamGrant = {
  teamId: string;
  teamName: string;
  createdAt: string;
};

const apiError = async (response: Response, fallback: string): Promise<never> => {
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || fallback);
};

const jsonRequest = async <T>(url: string, init?: RequestInit, fallback = 'Knowledge base request failed'): Promise<T> => {
  const response = await apiFetch(url, init);
  if (!response.ok) return apiError(response, fallback);
  return response.json() as Promise<T>;
};

const jsonBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export type GovernanceTeam = { id: string; name: string; isLead: boolean };

export const fetchEligibleTeams = async (): Promise<GovernanceTeam[]> => {
  const body = await jsonRequest<{ teams?: GovernanceTeam[] } | GovernanceTeam[]>(
    `${API_URL}/teams/mine`, undefined, 'Failed to load your teams',
  );
  return Array.isArray(body) ? body : (body.teams ?? []);
};

export const fetchKnowledgeBaseCatalog = () =>
  jsonRequest<KnowledgeBaseSummary[]>(`${API_URL}/knowledge-bases/catalog`, undefined, 'Failed to load knowledge bases');

export const fetchMyKnowledgeBases = () =>
  jsonRequest<KnowledgeBaseSummary[]>(`${API_URL}/knowledge-bases/mine`, undefined, 'Failed to load your knowledge bases');

// Read-only OKF explorer data for a member source, scoped to (and authorized by) a knowledge base.
const sourcePath = (kbId: string, sourceId: number) =>
  `${API_URL}/knowledge-bases/${encodeURIComponent(kbId)}/sources/${sourceId}`;

export const fetchKnowledgeBaseSourceBundle = (kbId: string, sourceId: number) =>
  jsonRequest<KnowledgeBundleManifest>(`${sourcePath(kbId, sourceId)}/bundle`, undefined, 'Failed to load OKF bundle');

export const fetchKnowledgeBaseSourceBundleFile = (kbId: string, sourceId: number, path: string) =>
  jsonRequest<KnowledgeBundleFileContent>(`${sourcePath(kbId, sourceId)}/bundle/file?path=${encodeURIComponent(path)}`, undefined, 'Failed to load bundle file');

export const fetchKnowledgeBaseSourceGraph = (kbId: string, sourceId: number) =>
  jsonRequest<KnowledgeGraphSummary>(`${sourcePath(kbId, sourceId)}/graph`, undefined, 'Failed to load knowledge graph');

export const fetchKnowledgeBaseSourceSnapshots = (kbId: string, sourceId: number) =>
  jsonRequest<KnowledgeSnapshot[]>(`${sourcePath(kbId, sourceId)}/snapshots`, undefined, 'Failed to load snapshots');

export type AssignableSource = {
  knowledgeSourceId: number;
  title: string;
  type: string;
  knowledgeBaseId?: string | null;
  knowledgeBaseName?: string | null;
};

export const fetchAssignableSources = () =>
  jsonRequest<AssignableSource[]>(`${API_URL}/knowledge-bases/assignable-sources`, undefined, 'Failed to load assignable sources');

export const createKnowledgeBase = (input: { name: string; description?: string; ownerTeamId: string }) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases`, jsonBody('POST', input), 'Failed to create knowledge base');

export const fetchKnowledgeBase = (id: string) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}`, undefined, 'Failed to load knowledge base');

export const updateKnowledgeBase = (id: string, patch: { name?: string; description?: string | null; ownerTeamId?: string }) =>
  jsonRequest<KnowledgeBaseSummary>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}`, jsonBody('PATCH', patch), 'Failed to update knowledge base');

export const addKnowledgeBaseSource = (id: string, knowledgeSourceId: number) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/sources`, jsonBody('POST', { knowledgeSourceId }), 'Failed to add source');

export const removeKnowledgeBaseSource = (id: string, sourceId: number) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/sources/${sourceId}`, jsonBody('DELETE'), 'Failed to remove source');

export const publishKnowledgeBase = (id: string, input: { version?: string; note?: string } = {}) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/publish`, jsonBody('POST', input), 'Failed to publish knowledge base');

export const fetchKnowledgeBaseVersions = (id: string) =>
  jsonRequest<KnowledgeBaseVersionEntry[]>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/versions`, undefined, 'Failed to load versions');

export const fetchKnowledgeBaseTeams = (id: string) =>
  jsonRequest<KnowledgeBaseTeamGrant[]>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/teams`, undefined, 'Failed to load team grants');

export const grantKnowledgeBaseTeam = (id: string, teamId: string) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/teams/${encodeURIComponent(teamId)}`, jsonBody('PUT'), 'Failed to grant team access');

export const revokeKnowledgeBaseTeam = (id: string, teamId: string) =>
  jsonRequest<KnowledgeBaseDetail>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/teams/${encodeURIComponent(teamId)}`, jsonBody('DELETE'), 'Failed to revoke team access');

export const archiveKnowledgeBase = (id: string) =>
  jsonRequest<KnowledgeBaseSummary>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/archive`, jsonBody('POST'), 'Failed to archive knowledge base');

export const restoreKnowledgeBase = (id: string) =>
  jsonRequest<KnowledgeBaseSummary>(`${API_URL}/knowledge-bases/${encodeURIComponent(id)}/restore`, jsonBody('POST'), 'Failed to restore knowledge base');

// Direct upload into a knowledge base. Reuse `putGlobalKnowledgeUpload` (from knowledgeApi)
// for the byte PUT — it is KB-agnostic and just PUTs to session.uploadUrl.
export const createKnowledgeBaseUploadSession = (
  id: string,
  file: File,
  payload: { title: string; type: string; description?: string; metadata?: Record<string, unknown> },
) => jsonRequest<KnowledgeUploadSession>(
  `${API_URL}/knowledge-bases/${encodeURIComponent(id)}/uploads`,
  jsonBody('POST', {
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    ...payload,
  }),
  'Failed to start upload',
);

export const completeKnowledgeBaseUpload = (id: string, uploadId: string) =>
  jsonRequest<KnowledgeBaseDetail | Record<string, unknown>>(
    `${API_URL}/knowledge-bases/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}/complete`,
    jsonBody('POST'),
    'Failed to finalize upload',
  );

export const cancelKnowledgeBaseUpload = (id: string, uploadId: string) =>
  jsonRequest<Record<string, unknown>>(
    `${API_URL}/knowledge-bases/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}`,
    jsonBody('DELETE'),
    'Failed to cancel upload',
  );
