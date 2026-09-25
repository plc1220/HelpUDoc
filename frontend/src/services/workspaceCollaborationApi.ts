import type {
  TeamChatReference,
  TeamThreadSummary,
  TeamThreadListResponse,
  TeamThreadMessagesResponse,
  TeamThreadStatus,
  TeamThreadReadiness,
} from '../types';
import { API_URL, apiFetch } from './apiClient';

export type {
  TeamThreadSummary,
  TeamThreadListResponse,
  TeamThreadMessagesResponse,
  TeamThreadStatus,
  TeamThreadRunStatus,
  TeamThreadParticipant,
  TeamThreadReadiness,
} from '../types';

export type WorkspaceCollaborationObjectType =
  | 'annotation'
  | 'sticky_note'
  | 'task'
  | 'change_proposal';

export type WorkspaceCollaborationStatus =
  | 'open'
  | 'discussing'
  | 'proposed'
  | 'resolved'
  | 'addressed'
  | 'anchor_changed';

export type WorkspaceCollaborationObject = {
  id: string;
  workspaceId: string;
  originVersionId: string | null;
  type: WorkspaceCollaborationObjectType;
  visibility: 'private' | 'workspace_audience';
  status: WorkspaceCollaborationStatus;
  filePath: string | null;
  anchorText?: string;
  anchorStart?: number;
  anchorEnd?: number;
  blockId?: string;
  anchorFingerprint?: string;
  title: string | null;
  body: string;
  authorId: string | null;
  authorName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  linkedPrivateWorkspaceId: string | null;
  resolvedByVersionId: string | null;
  sourceTeamMessageId: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type WorkspaceCollaborationMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceTeamMessage = {
  id: string;
  workspaceId: string;
  originVersionId: string | null;
  originVersionNumber: number | null;
  authorId: string | null;
  authorType: 'user' | 'lumo' | 'system';
  authorName: string;
  body: string;
  replyToMessageId: string | null;
  threadRootId: string | null;
  /**
   * Runtime fields present in the JSON (`teamMessageQuery` selects `message.*`)
   * but omitted from the backend TS type. The thread UI relies on `sequence`
   * for pagination cursors / read-state and `threadId` for stale-response
   * guarding. Modeled optional so legacy responses without them still parse.
   */
  threadId?: string | null;
  sequence?: number | null;
  clientMessageId?: string | null;
  mentionsLumo: boolean;
  mentionedUserIds: string[];
  isMentioned: boolean;
  isMine: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

const parseError = async (response: Response, fallback: string): Promise<never> => {
  const payload = await response.json().catch(() => ({}));
  throw new Error(typeof payload?.error === 'string' ? payload.error : fallback);
};

/**
 * Typed error carrying the HTTP status and any server error code so the thread
 * UI can distinguish access loss (401/403), not-found (404), idempotency reuse
 * (409 IDEMPOTENCY_KEY_REUSE) and an active Lumo slot (409 THREAD_RUN_ACTIVE)
 * without string matching.
 */
export class TeamThreadApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TeamThreadApiError';
    this.status = status;
    this.code = code;
  }
  get isAccessLoss() {
    return this.status === 401 || this.status === 403;
  }
  get isRunActive() {
    return this.status === 409 && this.code === 'THREAD_RUN_ACTIVE';
  }
  get isIdempotencyReuse() {
    return this.status === 409 && (this.code === 'IDEMPOTENCY_KEY_REUSE' || this.code === 'IDEMPOTENCY_KEY_REUSED');
  }
}

const throwTyped = async (response: Response, fallback: string): Promise<never> => {
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof payload?.error === 'string' ? payload.error : fallback;
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  throw new TeamThreadApiError(message, response.status, code);
};

export const listWorkspaceCollaborationObjects = async (
  workspaceId: string,
): Promise<WorkspaceCollaborationObject[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaboration/objects`);
  if (!response.ok) {
    return parseError(response, 'Failed to load collaboration');
  }
  const payload = await response.json() as { objects?: WorkspaceCollaborationObject[] };
  return payload.objects || [];
};

export const getWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
): Promise<{
  object: WorkspaceCollaborationObject;
  messages: WorkspaceCollaborationMessage[];
}> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}`,
  );
  if (!response.ok) {
    return parseError(response, 'Failed to load collaboration item');
  }
  return response.json();
};

export const createWorkspaceCollaborationObject = async (
  workspaceId: string,
  payload: {
    type: WorkspaceCollaborationObjectType;
    visibility: 'private' | 'workspace_audience';
    title?: string;
    body: string;
    filePath?: string;
    /** Canonical file id, so the backend validates identity against filePath and
     *  rejects a version UUID from a different file (F8). */
    fileId?: number;
    /**
     * The EXACT immutable file version the user was viewing when anchoring
     * (incl. a published/historical view). The ACTUAL backend route accepts
     * `anchorVersionId` (an early contract said `originVersionId`, which the
     * route strips — see round34 coordination). Omit when unknown — never pin
     * latest/Working silently.
     */
    anchorVersionId?: string;
    /** Explicitly link a NEW workspace-audience object to a thread (F8). A
     *  private annotation must never carry this. */
    sourceThreadId?: string;
    sourceTeamMessageId?: string;
    anchorText?: string;
    anchorStart?: number;
    anchorEnd?: number;
    blockId?: string;
    anchorFingerprint?: string;
  },
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaboration/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return parseError(response, 'Failed to create collaboration item');
  }
  return response.json();
};

export const listWorkspaceTeamMessages = async (
  workspaceId: string,
  limit = 200,
  includeMessageId?: string,
): Promise<WorkspaceTeamMessage[]> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/team-chat/messages?limit=${limit}${includeMessageId ? `&includeMessageId=${encodeURIComponent(includeMessageId)}` : ''}`,
  );
  if (!response.ok) {
    return parseError(response, 'Failed to load Workspace Chat');
  }
  const payload = await response.json() as { messages?: WorkspaceTeamMessage[] };
  return payload.messages || [];
};

export const postWorkspaceTeamMessage = async (
  workspaceId: string,
  payload: {
    body: string;
    replyToMessageId?: string;
    mentionedUserIds?: string[];
    references?: TeamChatReference[];
  },
): Promise<WorkspaceTeamMessage> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/team-chat/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to post Workspace Chat message');
  }
  return response.json();
};

export const invokeLumoForWorkspaceTeamMessage = async (
  workspaceId: string,
  messageId: string,
): Promise<{ status: 'queued' }> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/team-chat/messages/${messageId}/lumo`,
    { method: 'POST' },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to invoke Lumo');
  }
  return response.json();
};

export const replyToWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
  body: string,
): Promise<void> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to post reply');
  }
};

export const updateWorkspaceCollaborationObject = async (
  workspaceId: string,
  objectId: string,
  payload: { status: WorkspaceCollaborationStatus },
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to update collaboration item');
  }
  return response.json();
};

export const convertWorkspaceCollaborationObjectToProposal = async (
  workspaceId: string,
  objectId: string,
  sourceThreadId?: string,
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}/proposal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Record the ORIGIN thread on the private activity (F7). Author-only
      // metadata; grants nobody else access and never auto-shares changes.
      body: JSON.stringify(sourceThreadId ? { sourceThreadId } : {}),
    },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to create proposal');
  }
  return response.json();
};

export const applyWorkspaceCollaborationProposal = async (
  workspaceId: string,
  objectId: string,
): Promise<WorkspaceCollaborationObject> => {
  const response = await apiFetch(
    `${API_URL}/workspaces/${workspaceId}/collaboration/objects/${objectId}/apply`,
    { method: 'POST' },
  );
  if (!response.ok) {
    return parseError(response, 'Failed to apply proposal');
  }
  return response.json();
};

export const respondToTeamInteraction = async (workspaceId: string, messageId: string, input: { decision?: 'approve' | 'reject'; message?: string; actionId?: string }) => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/collaboration/team-chat/messages/${messageId}/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) return parseError(response, 'Unable to respond to Lumo');
};

// --- Team Chat threads (Release A) ---------------------------------------

const COLLAB_BASE = (workspaceId: string) =>
  `${API_URL}/workspaces/${workspaceId}/collaboration/team-chat`;

/** Rollout readiness gate (spec §7). Callers fail safe to legacy on error. */
export const getWorkspaceTeamThreadReadiness = async (
  workspaceId: string,
): Promise<TeamThreadReadiness> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/readiness`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load thread readiness');
  }
  const payload = (await response.json()) as Partial<TeamThreadReadiness> & Record<string, unknown>;
  // Preserve any forward-added fields (e.g. a future `releaseBEnabled`) while
  // normalizing the three required booleans/counters to safe defaults.
  return {
    ...payload,
    enabled: Boolean(payload.enabled),
    ready: Boolean(payload.ready),
    unmappedMessageCount: Number(payload.unmappedMessageCount ?? 0),
    releaseBEnabled: Boolean(payload.releaseBEnabled),
  } as TeamThreadReadiness;
};

export const listWorkspaceTeamThreads = async (
  workspaceId: string,
  params: { status?: TeamThreadStatus | 'all'; cursor?: string; limit?: number } = {},
): Promise<TeamThreadListResponse> => {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads${suffix}`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load threads');
  }
  const payload = (await response.json()) as Partial<TeamThreadListResponse>;
  return { threads: payload.threads || [], nextCursor: payload.nextCursor ?? null };
};

export const createWorkspaceTeamThread = async (
  workspaceId: string,
  payload: {
    title?: string;
    body: string;
    mentionedUserIds?: string[];
    references?: TeamChatReference[];
    clientMessageId: string;
  },
): Promise<{ thread: TeamThreadSummary; message: WorkspaceTeamMessage }> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to create thread');
  }
  return response.json();
};

export const getWorkspaceTeamThread = async (
  workspaceId: string,
  threadId: string,
): Promise<TeamThreadSummary> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load thread');
  }
  const payload = (await response.json()) as { thread: TeamThreadSummary };
  return payload.thread;
};

export const listWorkspaceTeamThreadMessages = async (
  workspaceId: string,
  threadId: string,
  params: { beforeSeq?: number; afterSeq?: number; aroundMessageId?: string; limit?: number } = {},
): Promise<TeamThreadMessagesResponse<WorkspaceTeamMessage>> => {
  const query = new URLSearchParams();
  if (params.beforeSeq !== undefined) query.set('beforeSeq', String(params.beforeSeq));
  if (params.afterSeq !== undefined) query.set('afterSeq', String(params.afterSeq));
  if (params.aroundMessageId) query.set('aroundMessageId', params.aroundMessageId);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}/messages${suffix}`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load thread messages');
  }
  return response.json();
};

export const postWorkspaceTeamThreadMessage = async (
  workspaceId: string,
  threadId: string,
  payload: {
    body: string;
    replyToMessageId?: string;
    mentionedUserIds?: string[];
    references?: TeamChatReference[];
    clientMessageId: string;
  },
): Promise<WorkspaceTeamMessage> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to post thread message');
  }
  return response.json();
};

export const patchWorkspaceTeamThread = async (
  workspaceId: string,
  threadId: string,
  payload: { title?: string; status?: TeamThreadStatus },
): Promise<TeamThreadSummary> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to update thread');
  }
  const result = (await response.json()) as { thread: TeamThreadSummary };
  return result.thread;
};

export const setWorkspaceTeamThreadReadState = async (
  workspaceId: string,
  threadId: string,
  lastReadSeq: number,
): Promise<{ lastReadSeq: number }> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}/read-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastReadSeq }),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to update read state');
  }
  return response.json();
};

export const setWorkspaceTeamThreadFollowState = async (
  workspaceId: string,
  threadId: string,
  following: boolean,
): Promise<{ following: boolean }> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/threads/${threadId}/follow-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ following }),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to update follow state');
  }
  return response.json();
};

/** Resolve the owning thread for a legacy/deep-link message id (server-side). */
export const resolveWorkspaceTeamThreadForMessage = async (
  workspaceId: string,
  messageId: string,
): Promise<{ threadId: string; message?: WorkspaceTeamMessage; sequence?: number | null }> => {
  const response = await apiFetch(`${COLLAB_BASE(workspaceId)}/messages/${messageId}`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to resolve message');
  }
  return response.json();
};
