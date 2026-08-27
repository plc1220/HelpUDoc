import type {
  FileAuditEvent,
  FileProvenanceDocument,
  FileProvenanceEvent,
  FileProvenanceOrigin,
  FileProvenanceOriginKind,
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

export interface ProvenanceFileInput {
  id: number | string;
  workspaceId: string;
  name: string;
  version?: number | null;
  createdAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

export interface BuildProvenanceInput {
  file: ProvenanceFileInput;
  /** Audit rows for this file, any order. */
  events: Array<Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string }>;
  /** Rows inherited across a publication boundary, if the bridge was followed. */
  priorEvents?: Array<Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string }>;
  /** Display names by user id, so the document is readable standalone. */
  actorNames?: Record<string, string | null>;
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

function toDocumentEvent(
  row: Partial<FileAuditEvent> & { seq: number; eventType: string; eventHash: string },
  chain: 'current' | 'prior',
  actorNames: Record<string, string | null>,
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
    provenance: null,
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
  const priorEvents = [...(input.priorEvents ?? [])]
    .sort(bySeq)
    .map((row) => toDocumentEvent(row, 'prior', actorNames));
  const currentEvents = [...input.events]
    .sort(bySeq)
    .map((row) => toDocumentEvent(row, 'current', actorNames));

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
