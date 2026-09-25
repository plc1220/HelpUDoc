import type {
  FileAgentProvenance,
  FileAuditEvent,
  FileProvenanceDocument,
  FileProvenanceEvent,
  FileProvenanceOrigin,
  FileProvenanceOriginKind,
  FileStatus,
} from '@helpudoc/contracts/types';

import { computeEventHash } from './fileAuditService';

/**
 * Assembles raw audit rows into the provenance document served by the API,
 * frozen into publication snapshots, and rendered by the history dialog.
 *
 * Deliberately pure: no database, no I/O. Every caller feeds it rows it has
 * already fetched, which keeps the document shape testable in isolation and
 * identical across all three consumers.
 */

export const PROVENANCE_SCHEMA_VERSION = '1.0';

/**
 * Editorial state for the document header.
 *
 * A status decision attaches to the version it was made on, so comparing it
 * against the current version is what tells a reader whether the content moved
 * on after sign-off.
 */
function buildStatusBlock(file: ProvenanceFileInput): {
  status: FileStatus | null;
  approvedAtVersion: number | null;
  publishedAtVersion: number | null;
  drift: boolean;
} {
  const status = (file.status ?? null) as FileStatus | null;
  const approvedAtVersion = file.approvedAtVersion ?? null;
  const publishedAtVersion = file.publishedAtVersion ?? null;
  const decidedAt = status === 'published' ? publishedAtVersion : approvedAtVersion;
  return {
    status,
    approvedAtVersion,
    publishedAtVersion,
    drift: decidedAt != null && Number(decidedAt) !== Number(file.version ?? 0),
  };
}

export interface ProvenanceFileInput {
  id: number | string;
  workspaceId: string;
  name: string;
  version?: number | null;
  createdAt?: Date | string | null;
  deletedAt?: Date | string | null;
  status?: string | null;
  approvedAtVersion?: number | null;
  publishedAtVersion?: number | null;
}

export interface BuildProvenanceInput {
  file: ProvenanceFileInput;
  /** Audit rows for this file, any order. */
  events: Array<Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string }>;
  /** Rows inherited across a publication boundary, if the bridge was followed. */
  priorEvents?: Array<Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string }>;
  /** Display names by user id, so the document is readable standalone. */
  actorNames?: Record<string, string | null>;
  /** Agent run detail keyed by runId, attached to the events that came from a run. */
  runProvenance?: Record<string, any>;
}

const toIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Payload can arrive as a jsonb object or, from some drivers, a JSON string.
 * Never throw on malformed data — a broken payload must not hide the event.
 */
const normalizePayload = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
};

const ORIGIN_BY_EVENT: Record<string, FileProvenanceOriginKind> = {
  'file.created': 'uploaded',
  'file.agent_generated': 'agent_generated',
  'file.synced_from_publication': 'synced',
};

const bySeq = (
  left: { seq: number },
  right: { seq: number },
) => Number(left.seq) - Number(right.seq);

/** Shapes a stored run row into the provenance block attached to an event. */
function toAgentProvenance(row: any): FileAgentProvenance | null {
  if (!row) return null;
  const asArray = (value: unknown) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    return [];
  };
  return {
    runId: String(row.runId),
    userPrompt: row.userPrompt ?? null,
    enrichedPrompt: row.enrichedPrompt ?? null,
    responseText: row.responseText ?? null,
    skillsInvoked: asArray(row.skillsInvoked),
    knowledgeRefsDeclared: asArray(row.knowledgeRefsDeclared),
    knowledgeChunksRetrieved: asArray(row.knowledgeChunksRetrieved),
    taggedFileRefs: asArray(row.taggedFileRefs),
    langfuseTraceId: row.langfuseTraceId ?? null,
    langfuseTraceUrl: row.langfuseTraceUrl ?? null,
    conversationMessageId: row.conversationMessageId ? Number(row.conversationMessageId) : null,
    truncated: typeof row.truncated === 'object' && row.truncated ? row.truncated : {},
  };
}

function toDocumentEvent(
  row: Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string },
  chain: 'current' | 'prior',
  actorNames: Record<string, string | null>,
  runProvenance: Record<string, any> = {},
): FileProvenanceEvent {
  const actorUserId = row.actorUserId ?? null;
  const displayName = row.actorDisplayName
    ?? (actorUserId ? actorNames[actorUserId] ?? null : null);
  return {
    ...(row as FileAuditEvent),
    seq: Number(row.seq),
    fileId: Number(row.fileId ?? 0),
    payload: normalizePayload(row.payload),
    occurredAt: toIso(row.occurredAt as unknown as string) ?? '',
    chain,
    actor: actorUserId || displayName ? { userId: actorUserId, displayName } : null,
    provenance: row.runId ? toAgentProvenance(runProvenance[String(row.runId)]) : null,
  };
}

/**
 * Walks the per-file hash chain. Returns the first `seq` whose recomputed hash
 * or predecessor link does not match, or null when the chain is intact.
 */
export function verifyEventChain(
  events: Array<Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string }>,
): { verified: boolean; brokenAtSeq: number | null } {
  const ordered = [...events].sort(bySeq);
  let previousHash: string | null = null;
  for (const event of ordered) {
    const expected = computeEventHash({
      prevEventHash: previousHash,
      fileId: Number(event.fileId ?? 0),
      seq: Number(event.seq),
      eventType: event.eventType,
      actorUserId: event.actorUserId ?? null,
      occurredAt: (event.occurredAt as unknown as string) ?? new Date(0).toISOString(),
      payload: normalizePayload(event.payload),
    });
    if (expected !== event.eventHash || (event.prevEventHash ?? null) !== previousHash) {
      return { verified: false, brokenAtSeq: Number(event.seq) };
    }
    previousHash = event.eventHash;
  }
  return { verified: true, brokenAtSeq: null };
}

function buildOrigin(
  events: FileProvenanceEvent[],
  priorEvents: FileProvenanceEvent[],
): FileProvenanceOrigin {
  // The origin is the earliest event we can see — which, when the bridge was
  // followed, lives in the prior workspace rather than this one.
  const earliest = (priorEvents.length ? priorEvents : events)[0];
  if (!earliest) {
    return { kind: 'unknown', occurredAt: null, actor: null, runId: null, priorWorkspace: null };
  }

  const bridge = events.find((event) => event.sourceFileVersionId);
  return {
    kind: ORIGIN_BY_EVENT[earliest.eventType] ?? 'unknown',
    occurredAt: earliest.occurredAt || null,
    actor: earliest.actor ?? null,
    runId: earliest.runId ?? null,
    priorWorkspace: bridge?.sourceFileVersionId
      ? {
        workspaceId: priorEvents[0]?.workspaceId ?? '',
        fileId: priorEvents[0]?.fileId ?? null,
        linkedVia: 'sourceFileVersionId',
        bridgeVersionId: String(bridge.sourceFileVersionId),
        eventCount: priorEvents.length,
        accessible: priorEvents.length > 0,
      }
      : null,
  };
}

export function buildProvenanceDocument(input: BuildProvenanceInput): FileProvenanceDocument {
  const actorNames = input.actorNames ?? {};
  const runProvenance = input.runProvenance ?? {};
  const priorEvents = [...(input.priorEvents ?? [])]
    .sort(bySeq)
    .map((row) => toDocumentEvent(row, 'prior', actorNames, runProvenance));
  const currentEvents = [...input.events]
    .sort(bySeq)
    .map((row) => toDocumentEvent(row, 'current', actorNames, runProvenance));

  const chain = verifyEventChain(input.events);
  const chainHead = currentEvents.length
    ? currentEvents[currentEvents.length - 1].eventHash
    : null;

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    file: {
      id: Number(input.file.id),
      workspaceId: input.file.workspaceId,
      name: input.file.name,
      currentVersion: Number(input.file.version ?? 0),
      createdAt: toIso(input.file.createdAt),
      deletedAt: toIso(input.file.deletedAt),
      ...buildStatusBlock(input.file),
    },
    // Prior-workspace history reads first so the document tells the story in
    // the order it happened.
    origin: buildOrigin(currentEvents, priorEvents),
    events: [...priorEvents, ...currentEvents],
    integrity: {
      chainHead,
      verified: chain.verified,
      brokenAtSeq: chain.brokenAtSeq,
      eventCount: priorEvents.length + currentEvents.length,
    },
  };
}
