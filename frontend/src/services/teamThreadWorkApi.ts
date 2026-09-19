/**
 * Release B (F6–F8) work-history / proposal / linked-item API client.
 *
 * OWNERSHIP: This is a NEW frontend service owned by the Release B frontend
 * session. It deliberately does NOT edit the Release-A-owned
 * `workspaceCollaborationApi.ts`. It re-uses that file's `apiFetch`/`API_URL`
 * transport and its typed `TeamThreadApiError` (import is allowed; editing is
 * not). Shared DTOs already present in `@helpudoc/contracts` are re-used;
 * shapes the backend contract still marks PENDING are defined LOCALLY here and
 * will be migrated to the shared contracts package once the backend session
 * publishes them (see /tmp/helpudoc-kiro-threads/frontend-b-backend-needs.md).
 *
 * The backend contract this tracks:
 *   /tmp/helpudoc-kiro-threads/release-b-backend-contract.md
 */
import type {
  TeamThreadChangeRecord,
  ProposalChangeSet,
  ProposalChangeSetOperation,
  ProposalChangeSetReview,
  ProposalChangeSetSummary,
  ProposalPrivateNavigation,
  SubmissionCandidate,
  SubmissionCandidatesResponse,
  ThreadLinkedItem,
  TeamThreadReadiness,
} from '../types';
import { API_URL, apiFetch, buildApiUrl } from './apiClient';
import { TeamThreadApiError } from './workspaceCollaborationApi';

export type {
  TeamThreadChangeRecord,
  ProposalChangeSet,
  ProposalChangeSetOperation,
  ProposalChangeSetReview,
  ProposalChangeSetSummary,
  ProposalPrivateNavigation,
  SubmissionCandidate,
  SubmissionCandidatesResponse,
  ThreadLinkedItem,
};
export { TeamThreadApiError };

const throwTyped = async (response: Response, fallback: string): Promise<never> => {
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof payload?.error === 'string' ? payload.error : fallback;
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  const error = new TeamThreadApiError(message, response.status, code);
  // Preserve any structured detail (e.g. MISSING_REQUIRED_DEPENDENCIES carries
  // {missing, byOperation}) so callers can render an actionable message.
  (error as unknown as { detail?: unknown }).detail = payload;
  throw error;
};

const COLLAB = (workspaceId: string) =>
  `${API_URL}/workspaces/${workspaceId}/collaboration`;
const TEAM = (workspaceId: string) => `${COLLAB(workspaceId)}/team-chat`;

// ---------------------------------------------------------------------------
// Release B readiness gate
// ---------------------------------------------------------------------------

/**
 * Release B readiness. The shared `TeamThreadReadiness`
 * (enabled/ready/unmappedMessageCount + releaseBEnabled) now carries the
 * separate, default-OFF `releaseBEnabled` gate (backend contract §0, landed), so
 * this is a direct alias of the shared type. Kept as a named export for callers
 * that only care about the Release B gate.
 */
export type ReleaseBReadiness = TeamThreadReadiness;

/**
 * Fetch readiness and derive the Release B gate. On ANY non-200/network error
 * every gate is treated as false (fail safe) — Release B surfaces stay hidden
 * and never disable already-safe Release A behavior.
 *
 * B surfaces should render only when `enabled && ready && releaseBEnabled`;
 * callers can use {@link isReleaseBReady}.
 */
export const getReleaseBReadiness = async (
  workspaceId: string,
): Promise<ReleaseBReadiness> => {
  try {
    const response = await apiFetch(`${TEAM(workspaceId)}/readiness`);
    if (!response.ok) {
      return { enabled: false, ready: false, unmappedMessageCount: 0, releaseBEnabled: false };
    }
    const payload = (await response.json()) as Partial<ReleaseBReadiness>;
    return {
      enabled: Boolean(payload.enabled),
      ready: Boolean(payload.ready),
      unmappedMessageCount: Number(payload.unmappedMessageCount ?? 0),
      releaseBEnabled: Boolean(payload.releaseBEnabled),
    };
  } catch {
    return { enabled: false, ready: false, unmappedMessageCount: 0, releaseBEnabled: false };
  }
};

export const isReleaseBReady = (readiness: ReleaseBReadiness | null | undefined): boolean =>
  Boolean(readiness && readiness.enabled && readiness.ready && readiness.releaseBEnabled);

// ---------------------------------------------------------------------------
// F6 — Changes from this discussion
// ---------------------------------------------------------------------------

export interface ThreadChangesResponse {
  changes: TeamThreadChangeRecord[];
  nextCursor: string | null;
}

/**
 * `GET /team-chat/threads/:threadId/changes?runId&cursor&limit`
 * Cursor-paginated, workspace+thread scoped. `runId` narrows to a single run
 * (the cursor stays scoped to that filter). Never a whole-thread diff of
 * current state — every record is an attributed immutable operation.
 */
export const listThreadChanges = async (
  workspaceId: string,
  threadId: string,
  params: { runId?: string; cursor?: string; limit?: number } = {},
): Promise<ThreadChangesResponse> => {
  const query = new URLSearchParams();
  if (params.runId) query.set('runId', params.runId);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await apiFetch(`${TEAM(workspaceId)}/threads/${threadId}/changes${suffix}`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load changes');
  }
  const payload = (await response.json()) as Partial<ThreadChangesResponse>;
  return { changes: payload.changes || [], nextCursor: payload.nextCursor ?? null };
};

/**
 * Authenticated URL for the EXACT immutable bytes behind a Changes record.
 * `side=after` = this version's bytes; `side=before` = its base version's
 * bytes (404 for a create). Works even when the file is now deleted (it reads
 * the immutable file_versions row, not the live file). Never a latest-content
 * fallback. Used for the text diff and for a safe download / office preview.
 */
export const threadChangeContentUrl = (
  workspaceId: string,
  threadId: string,
  versionId: string,
  side: 'before' | 'after',
): string => {
  const url = buildApiUrl(
    `/workspaces/${workspaceId}/collaboration/team-chat/threads/${threadId}/changes/${versionId}/content`,
  );
  url.searchParams.set('side', side);
  return url.toString();
};

export interface ThreadChangeBytes {
  /** Decoded UTF-8 text when the payload is a supported text type, else null. */
  text: string | null;
  /** True when the payload is binary (no meaningful text diff — offer preview/download). */
  binary: boolean;
  contentType: string;
  byteLength: number;
  /** The side is legitimately absent per trusted metadata (create has no
   *  before; delete has no after). NOT set for an unexpected 404. */
  absent: boolean;
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-ndjson)|application\/.*\+(json|xml))/i;

/** Classify already-fetched bytes into text/binary. HTML/SVG are treated as
 *  binary (download/preview only) so a stored document never executes in our
 *  origin. */
function classifyBytes(contentType: string, buffer: ArrayBuffer): ThreadChangeBytes {
  const type = (contentType || '').split(';')[0].trim();
  const isHtmlLike = /html|svg/i.test(type);
  if (TEXTUAL.test(type) && !isHtmlLike) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    return { text, binary: false, contentType: type, byteLength: buffer.byteLength, absent: false };
  }
  return {
    text: null,
    binary: true,
    contentType: type || 'application/octet-stream',
    byteLength: buffer.byteLength,
    absent: false,
  };
}

/**
 * Fetch the immutable bytes for a Changes side and classify them for the diff
 * view.
 *
 * Point 4 fix: a 404 is only interpreted as a legitimately-absent side when the
 * CALLER already knows (from trusted operation metadata) that the side must be
 * empty — i.e. `expectAbsent` is true (create → no `before`, delete → no
 * `after`). Any OTHER non-2xx (missing/unauthorized/corrupt snapshot) is a real
 * error and surfaces as a failed preview; it never masquerades as
 * empty/deleted content behind a misleading successful diff.
 *
 * SECURITY: bytes are only ever read via `fetch()` + arrayBuffer; they are
 * never injected as same-origin HTML.
 */
export const fetchThreadChangeBytes = async (
  workspaceId: string,
  threadId: string,
  versionId: string,
  side: 'before' | 'after',
  expectAbsent = false,
): Promise<ThreadChangeBytes> => {
  const response = await apiFetch(threadChangeContentUrl(workspaceId, threadId, versionId, side));
  if (response.status === 404 && expectAbsent) {
    return { text: null, binary: false, contentType: '', byteLength: 0, absent: true };
  }
  if (!response.ok) {
    return throwTyped(response, 'Failed to load version bytes');
  }
  const buffer = await response.arrayBuffer();
  return classifyBytes(response.headers.get('Content-Type') || '', buffer);
};

/**
 * Download the exact immutable bytes of a Changes side as an object URL, using
 * the authenticated transport (Point 7: a raw href bypasses header-identity
 * auth in local/header mode). Caller is responsible for revoking the URL.
 */
export const downloadThreadChangeBlobUrl = async (
  workspaceId: string,
  threadId: string,
  versionId: string,
  side: 'before' | 'after',
): Promise<{ url: string; contentType: string }> => {
  const response = await apiFetch(threadChangeContentUrl(workspaceId, threadId, versionId, side));
  if (!response.ok) {
    return throwTyped(response, 'Failed to download version');
  }
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), contentType: blob.type };
};

// ---------------------------------------------------------------------------
// F7 — Thread-linked Review proposals with explicit content selection
// ---------------------------------------------------------------------------

/** Parsed detail of a `MISSING_REQUIRED_DEPENDENCIES` (409) apply/submit error. */
export interface MissingDependencies {
  missing: string[];
  byOperation: Array<{ path: string; missing: string[] }>;
}

/** Extract `{missing, byOperation}` from a MISSING_REQUIRED_DEPENDENCIES error
 *  the server attached to the response body (best-effort; empty on absence). */
export const parseMissingDependencies = (error: unknown): MissingDependencies | null => {
  if (!(error instanceof TeamThreadApiError) || error.code !== 'MISSING_REQUIRED_DEPENDENCIES') {
    return null;
  }
  const detail = (error as unknown as { detail?: MissingDependencies }).detail;
  return {
    missing: Array.isArray(detail?.missing) ? detail!.missing : [],
    byOperation: Array.isArray(detail?.byOperation) ? detail!.byOperation : [],
  };
};

/**
 * `GET /objects/:objectId/submission-candidates?expectedSharedRevision=`
 * Owner-only pre-submit disclosure (STATUS: DONE per backend contract).
 *
 * Point 1 fix: the backend Zod REQUIRES `expectedSharedRevision`. The caller
 * MUST pass the exact Shared revision it observed (from the authorized
 * workspace/object). A stale revision surfaces as a typed error the UI shows
 * with a refresh affordance — we never auto-submit a new comparison.
 */
export const listSubmissionCandidates = async (
  workspaceId: string,
  objectId: string,
  expectedSharedRevision: number,
): Promise<SubmissionCandidatesResponse> => {
  const query = new URLSearchParams();
  query.set('expectedSharedRevision', String(expectedSharedRevision));
  const response = await apiFetch(
    `${COLLAB(workspaceId)}/objects/${objectId}/submission-candidates?${query.toString()}`,
  );
  if (!response.ok) {
    return throwTyped(response, 'Failed to load submission candidates');
  }
  const payload = (await response.json()) as Partial<SubmissionCandidatesResponse>;
  return {
    candidates: payload.candidates || [],
    baseSharedRevision: Number(payload.baseSharedRevision ?? 0),
    basePrivateRevision: Number(payload.basePrivateRevision ?? 0),
  };
};

/**
 * Author-only private navigation for a thread-linked proposal.
 * `GET /objects/:objectId/private-navigation` — returns the author's own
 * private workspace id + current private revision + origin threads. Non-authors
 * get 403. Public object/list responses NEVER carry `linkedPrivateWorkspaceId`
 * (it is redacted), so the submit UI MUST use THIS endpoint — never a public
 * object field — to open the private copy and to obtain `expectedPrivateRevision`.
 */
export const getProposalPrivateNavigation = async (
  workspaceId: string,
  objectId: string,
): Promise<ProposalPrivateNavigation> => {
  const response = await apiFetch(
    `${COLLAB(workspaceId)}/objects/${objectId}/private-navigation`,
  );
  if (!response.ok) {
    return throwTyped(response, 'Failed to load private navigation');
  }
  const payload = (await response.json()) as Partial<ProposalPrivateNavigation>;
  return {
    linkedPrivateWorkspaceId: payload.linkedPrivateWorkspaceId ?? null,
    privateContentRevision:
      payload.privateContentRevision === undefined || payload.privateContentRevision === null
        ? null
        : Number(payload.privateContentRevision),
    sourceThreadId: payload.sourceThreadId ?? null,
    originThreadIds: Array.isArray(payload.originThreadIds) ? payload.originThreadIds : [],
  };
};

/**
 * A review verdict on a submission. Extends the shared `ProposalChangeSetReview`
 * with an optional `reviewerName` the list/detail endpoints may include for a
 * friendlier display (falls back to the id).
 */
export interface SubmissionReview extends ProposalChangeSetReview {
  reviewerName?: string | null;
}

/**
 * A submission LIST row. The list endpoint returns SUMMARIES with
 * `operationCount` — NOT the full `operations[]`. Full operations are fetched
 * per-submission via {@link getProposalSubmission}. The shared
 * `ProposalChangeSetSummary` (imported above) is the canonical shape.
 */

/** A frozen submission with its FULL operations and review history. Extends the
 * shared ProposalChangeSet with reviewer/apply metadata the single-submission
 * endpoint returns. */
export interface ProposalSubmission extends ProposalChangeSet {
  appliedAt?: string | null;
  expectedPrivateRevision?: number | null;
  reviews: SubmissionReview[];
}

export interface SubmissionListResponse {
  submissions: ProposalChangeSetSummary[];
}

/**
 * `GET /objects/:objectId/submissions` — newest first, with review history.
 * Returns SUMMARIES (operationCount, no operations). Redacts private workspace
 * id / raw object keys server-side. STATUS: DONE per backend contract.
 */
export const listProposalSubmissions = async (
  workspaceId: string,
  objectId: string,
): Promise<ProposalChangeSetSummary[]> => {
  const response = await apiFetch(`${COLLAB(workspaceId)}/objects/${objectId}/submissions`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load submissions');
  }
  const payload = (await response.json()) as
    | Partial<SubmissionListResponse>
    | ProposalChangeSetSummary[];
  const submissions = Array.isArray(payload) ? payload : payload.submissions || [];
  return submissions.map((s) => ({
    ...s,
    operationCount: Number(s.operationCount ?? 0),
    reviews: s.reviews || [],
  }));
};

/** `GET /objects/:objectId/submissions/:submissionId` — authorized FULL preview
 *  (operations incl. rename fromPath, base revision, explanation, status,
 *  reviews). No private IDs / raw keys. STATUS: DONE. */
export const getProposalSubmission = async (
  workspaceId: string,
  objectId: string,
  submissionId: string,
): Promise<ProposalSubmission> => {
  const response = await apiFetch(
    `${COLLAB(workspaceId)}/objects/${objectId}/submissions/${submissionId}`,
  );
  if (!response.ok) {
    return throwTyped(response, 'Failed to load submission');
  }
  const payload = (await response.json()) as ProposalSubmission;
  return { ...payload, operations: payload.operations || [], reviews: payload.reviews || [] };
};

/**
 * Authenticated URL for a shared reviewer to fetch the FROZEN, proposal-owned
 * snapshot bytes of one selected operation — WITHOUT private-workspace
 * membership and without ever exposing a private/raw object key.
 * `side=after` = proposed bytes; `side=before` = shared base bytes.
 */
export const submissionOperationContentUrl = (
  workspaceId: string,
  objectId: string,
  submissionId: string,
  opIndex: number,
  side: 'before' | 'after',
): string => {
  const url = buildApiUrl(
    `/workspaces/${workspaceId}/collaboration/objects/${objectId}/submissions/${submissionId}/operations/${opIndex}/content`,
  );
  url.searchParams.set('side', side);
  return url.toString();
};

/** Fetch frozen snapshot bytes for one submission operation (shared reviewer,
 *  no private access). Same safe text/binary classification as F6, and the same
 *  Point 4 rule: only a `expectAbsent` side (create → no before, delete → no
 *  after) treats 404 as legitimately empty; any other error is a real failure. */
export const fetchSubmissionOperationBytes = async (
  workspaceId: string,
  objectId: string,
  submissionId: string,
  opIndex: number,
  side: 'before' | 'after',
  expectAbsent = false,
): Promise<ThreadChangeBytes> => {
  const response = await apiFetch(
    submissionOperationContentUrl(workspaceId, objectId, submissionId, opIndex, side),
  );
  if (response.status === 404 && expectAbsent) {
    return { text: null, binary: false, contentType: '', byteLength: 0, absent: true };
  }
  if (!response.ok) {
    return throwTyped(response, 'Failed to load snapshot bytes');
  }
  const buffer = await response.arrayBuffer();
  return classifyBytes(response.headers.get('Content-Type') || '', buffer);
};

/** Authenticated blob download for a submission operation snapshot (Point 7 —
 *  works in header-identity auth modes; caller revokes the URL). */
export const downloadSubmissionOperationBlobUrl = async (
  workspaceId: string,
  objectId: string,
  submissionId: string,
  opIndex: number,
  side: 'before' | 'after',
): Promise<{ url: string; contentType: string }> => {
  const response = await apiFetch(
    submissionOperationContentUrl(workspaceId, objectId, submissionId, opIndex, side),
  );
  if (!response.ok) {
    return throwTyped(response, 'Failed to download snapshot');
  }
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), contentType: blob.type };
};

export interface SelectedOperationInput {
  path: string;
  fileId?: number | null;
  changeKind?: string;
}

/**
 * `POST /objects/:objectId/submissions` — freeze an immutable manifest of the
 * EXPLICITLY selected operations. `expectedPrivateRevision` is required (the
 * backend contract makes it MANDATORY to pin the reviewed private selection).
 * The server derives real versions/hashes/scope; a client `fileId` is a hint
 * only. Never "submit all private changes".
 */
export const submitProposalChangeSet = async (
  workspaceId: string,
  objectId: string,
  payload: {
    expectedSharedRevision: number;
    expectedPrivateRevision: number;
    selectedOperations: SelectedOperationInput[];
    publicExplanation?: string;
  },
): Promise<ProposalSubmission> => {
  const response = await apiFetch(`${COLLAB(workspaceId)}/objects/${objectId}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to submit change set');
  }
  const result = (await response.json()) as ProposalSubmission;
  return { ...result, reviews: result.reviews || [] };
};

/** `POST /objects/:objectId/submissions/:submissionId/reviews` — record a
 *  verdict against one EXACT submission. Does not itself edit files. */
export const reviewProposalSubmission = async (
  workspaceId: string,
  objectId: string,
  submissionId: string,
  payload: { verdict: 'approved' | 'changes_requested'; comment?: string },
): Promise<SubmissionReview> => {
  const response = await apiFetch(
    `${COLLAB(workspaceId)}/objects/${objectId}/submissions/${submissionId}/reviews`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    return throwTyped(response, 'Failed to record review');
  }
  return response.json();
};

export type ApplyConflictCode =
  | 'PROPOSAL_STALE'
  | 'SUBMISSION_ALREADY_APPLIED'
  | 'SUBMISSION_SUPERSEDED'
  | 'SUBMISSION_REQUIRED';

/**
 * `POST /objects/:objectId/apply` with `{submissionId, expectedSharedRevision}`.
 * Applies the frozen submission ONCE, rechecking revision under lock.
 * Typed conflicts surface via `TeamThreadApiError.code`:
 *   PROPOSAL_STALE            — Shared Working moved; refresh + resubmit.
 *   SUBMISSION_ALREADY_APPLIED
 *   SUBMISSION_SUPERSEDED     — a newer submission exists.
 *   SUBMISSION_REQUIRED       — legacy whole-copy apply rejected for a
 *                               thread-linked proposal (must freeze a selection).
 */
export const applyProposalSubmission = async (
  workspaceId: string,
  objectId: string,
  payload: { submissionId: string; expectedSharedRevision: number },
): Promise<{ status: string }> => {
  const response = await apiFetch(`${COLLAB(workspaceId)}/objects/${objectId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to apply submission');
  }
  return response.json();
};

// ---------------------------------------------------------------------------
// F8 — Link document discussions without duplicating them
// ---------------------------------------------------------------------------

/** `GET /team-chat/threads/:threadId/linked-items` — objects linked to the
 *  thread. Opens the ORIGINAL object; never copies replies. Uses the shared
 *  `ThreadLinkedItem` DTO (imported above; now carries fileId + fileDeleted). */
export const listThreadLinkedItems = async (
  workspaceId: string,
  threadId: string,
): Promise<ThreadLinkedItem[]> => {
  const response = await apiFetch(`${TEAM(workspaceId)}/threads/${threadId}/linked-items`);
  if (!response.ok) {
    return throwTyped(response, 'Failed to load linked items');
  }
  const payload = (await response.json()) as { items?: ThreadLinkedItem[] };
  return payload.items || [];
};

/**
 * `PATCH /objects/:objectId` `{ sourceThreadId }` — explicitly link (or unlink
 * with `null`) an EXISTING workspace-audience object to a thread. Author or
 * moderator only. Linking a private annotation is refused server-side
 * (`ANNOTATION_PRIVATE`) — it must be shared first.
 */
export const setObjectThreadLink = async (
  workspaceId: string,
  objectId: string,
  sourceThreadId: string | null,
): Promise<void> => {
  const response = await apiFetch(`${COLLAB(workspaceId)}/objects/${objectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceThreadId }),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to update thread link');
  }
};

/**
 * `POST /objects/:objectId/reattach-anchor` — re-pin a stale anchor to a NEW
 *  immutable version, clearing `anchor_changed`. Author/moderator only.
 *
 * Point 3 fix: `anchorVersionId` MUST be a real immutable `file_versions` UUID
 * — never a version NUMBER stringified. Callers obtain the target version's id
 * from an authorized version list (e.g. fileApi.getFileVersions) and pass
 * explicit offsets/excerpt/fingerprint chosen by the user; this function does
 * not fabricate an id from a version number.
 */
export const reattachObjectAnchor = async (
  workspaceId: string,
  objectId: string,
  payload: {
    anchorVersionId: string;
    anchorStart?: number;
    anchorEnd?: number;
    anchorText?: string;
    blockId?: string;
    anchorFingerprint?: string;
  },
): Promise<void> => {
  const response = await apiFetch(`${COLLAB(workspaceId)}/objects/${objectId}/reattach-anchor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return throwTyped(response, 'Failed to reattach anchor');
  }
};

/**
 * Build the EXPLICIT, version-pinned annotation reference the composer must add
 * to a Lumo request's `references` array to include a linked annotation.
 * Linking alone never invokes the agent — this is only used when the user
 * explicitly chooses to include the annotation in an invocation.
 */
export const buildAnnotationLumoReference = (item: ThreadLinkedItem): {
  kind: 'annotation';
  id: string;
  label: string;
  anchorVersionId?: string;
} => ({
  kind: 'annotation',
  id: item.objectId,
  label: item.title || item.anchorText || item.filePath || 'Annotation',
  ...(item.anchorVersionId ? { anchorVersionId: item.anchorVersionId } : {}),
});
