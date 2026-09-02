import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

import type {
  FileAuditActorType,
  FileAuditEventType,
} from '@helpudoc/contracts/types';

import { jsonbParam } from '../lib/jsonb';
import { isInternalWorkspacePath } from '../lib/workspacePaths';
import type { FileVersionChangeKind } from './fileService';

/**
 * Append-only per-file provenance trail.
 *
 * Every durable file mutation fans out one row here, written inside the same
 * transaction as the `file_versions` insert so the trail can never drift from
 * reality. Rows are denormalized on purpose: workspace deletion hard-deletes
 * `files` and `file_versions`, and an audit record has to outlive its subject.
 */

export interface FileAuditEventInput {
  fileId: number;
  workspaceId: string;
  filePath: string;
  eventType: FileAuditEventType;
  /**
   * Per-file monotonic ordinal. Callers allocate it from the locked
   * `files.auditSeq` counter rather than querying MAX(seq), which keeps the
   * write at zero extra round-trips. See `nextAuditSeq`.
   */
  seq: number;
  /** `files.lastAuditHash` of the preceding event; null for the first. */
  prevEventHash?: string | null;
  actorUserId?: string | null;
  actorType?: FileAuditActorType;
  actorDisplayName?: string | null;
  sha256?: string | null;
  objectKey?: string | null;
  fileVersionId?: string | null;
  sourceFileVersionId?: string | null;
  fileVersion?: number | null;
  runId?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  conversationMessageId?: number | null;
  langfuseTraceId?: string | null;
  payload?: Record<string, unknown>;
  /** Injectable for deterministic tests; defaults to now. */
  occurredAt?: Date;
}

export interface RecordedFileAuditEvent {
  id: string;
  seq: number;
  eventHash: string;
  occurredAt: Date;
}

/**
 * Deterministic serialization for hashing: object keys sorted, `undefined`
 * dropped. Two structurally equal payloads must always hash identically.
 */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry !== 'undefined')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
};

/**
 * uuid columns reject an empty string. The run pipeline hands optional ids
 * through as '' rather than undefined, which `?? null` does not catch, so
 * normalize before every insert.
 */
const nullIfEmpty = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

/**
 * Links each event to its predecessor, forming a per-file hash chain. The
 * publication snapshot pins the chain head so tampering is detectable.
 */
export function computeEventHash(input: {
  prevEventHash?: string | null;
  fileId: number;
  seq: number;
  eventType: string;
  actorUserId?: string | null;
  occurredAt: Date | string;
  payload?: Record<string, unknown>;
}): string {
  const occurredAt = input.occurredAt instanceof Date
    ? input.occurredAt.toISOString()
    : new Date(input.occurredAt).toISOString();
  return createHash('sha256').update(canonicalize({
    prevEventHash: input.prevEventHash ?? null,
    fileId: input.fileId,
    seq: input.seq,
    eventType: input.eventType,
    actorUserId: nullIfEmpty(input.actorUserId),
    occurredAt,
    payload: input.payload ?? {},
  })).digest('hex');
}

/** Next ordinal for a file whose row is already locked in this transaction. */
export const nextAuditSeq = (file: { auditSeq?: number | null }): number => (
  Number(file?.auditSeq ?? 0) + 1
);

/**
 * A content mutation is attributed to the agent when it landed via the
 * artifact-commit path of a run. There is no separate agent identity — the
 * acting user stays the human who started the run — so the discriminator is
 * carried by `actorType` instead.
 */
export const resolveActorType = (
  changeKind: FileVersionChangeKind | undefined,
  sourceRunId: string | null | undefined,
): FileAuditActorType => (
  changeKind === 'artifact' && sourceRunId ? 'agent' : 'human'
);

const CHANGE_KIND_EVENTS: Record<FileVersionChangeKind, FileAuditEventType> = {
  create: 'file.created',
  content: 'file.content_updated',
  artifact: 'file.agent_generated',
  rename: 'file.renamed',
  move: 'file.moved',
  restore: 'file.restored',
  delete: 'file.deleted',
};

export const eventTypeForChangeKind = (
  changeKind: FileVersionChangeKind,
): FileAuditEventType => CHANGE_KIND_EVENTS[changeKind] ?? 'file.content_updated';

/**
 * Writes one provenance event.
 *
 * Returns null for internal workspace paths (`.system/`, `sandbox-runs/`).
 * Those hold product-managed storage — immutable version blobs, upload staging
 * and the OKF knowledge bundles a single ingested document explodes into — not
 * documents anyone authored. They are hidden from the file browser, so auditing
 * them would bury the real trail (on a representative workspace they outnumber
 * user documents ~70:1) and put a SHA-256 chain write on the ingestion hot path
 * for records nothing will ever read.
 */
export async function recordFileEvent(
  tx: Knex | Knex.Transaction,
  input: FileAuditEventInput,
): Promise<RecordedFileAuditEvent | null> {
  if (isInternalWorkspacePath(input.filePath)) {
    return null;
  }
  const id = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const payload = input.payload ?? {};
  const eventHash = computeEventHash({
    prevEventHash: input.prevEventHash,
    fileId: input.fileId,
    seq: input.seq,
    eventType: input.eventType,
    actorUserId: nullIfEmpty(input.actorUserId),
    occurredAt,
    payload,
  });

  await tx('file_audit_events').insert({
    id,
    fileId: input.fileId,
    workspaceId: input.workspaceId,
    filePath: input.filePath,
    seq: input.seq,
    eventType: input.eventType,
    actorUserId: nullIfEmpty(input.actorUserId),
    actorType: input.actorType ?? 'human',
    actorDisplayName: input.actorDisplayName ?? null,
    sha256: input.sha256 ?? null,
    objectKey: input.objectKey ?? null,
    fileVersionId: nullIfEmpty(input.fileVersionId),
    sourceFileVersionId: nullIfEmpty(input.sourceFileVersionId),
    fileVersion: input.fileVersion ?? null,
    runId: nullIfEmpty(input.runId),
    conversationId: nullIfEmpty(input.conversationId),
    turnId: nullIfEmpty(input.turnId),
    conversationMessageId: input.conversationMessageId ?? null,
    langfuseTraceId: nullIfEmpty(input.langfuseTraceId),
    // `payload` can legitimately hold arrays; jsonbParam adds the ::jsonb cast
    // the pg driver otherwise mangles into a Postgres array literal.
    payload: jsonbParam(tx as Knex, payload),
    prevEventHash: input.prevEventHash ?? null,
    eventHash,
    occurredAt,
  });

  return { id, seq: input.seq, eventHash, occurredAt };
}
