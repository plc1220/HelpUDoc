/**
 * Shared test scaffolding for the per-file provenance trail.
 *
 * Two jobs:
 *  1. capture `file_audit_events` inserts without a database, and
 *  2. let the existing strict-mock tests (which throw on unexpected table
 *     access) absorb the new audit write without each one re-rolling its own
 *     allowlist.
 */

export interface CapturedAuditEvent {
  id: string;
  fileId: number;
  workspaceId: string;
  filePath: string;
  seq: number;
  eventType: string;
  actorUserId: string | null;
  actorType: string;
  sha256: string | null;
  objectKey: string | null;
  fileVersionId: string | null;
  sourceFileVersionId: string | null;
  fileVersion: number | null;
  runId: string | null;
  payload: unknown;
  prevEventHash: string | null;
  eventHash: string;
  occurredAt: Date;
}

/** Marker produced by our fake `raw`, so tests can read jsonb values back. */
interface RawMarker { __raw: string; bindings: unknown[] }

const isRawMarker = (value: unknown): value is RawMarker => (
  typeof value === 'object' && value !== null && '__raw' in (value as RawMarker)
);

/**
 * `jsonbParam` wraps values as `db.raw('?::jsonb', [json])`. Unwrap that so a
 * test can assert on the actual payload rather than on the binding envelope.
 */
export function decodeJsonb(value: unknown): unknown {
  if (!isRawMarker(value)) return value;
  const [encoded] = value.bindings;
  return typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
}

export function readPayload(event: { payload: unknown }): Record<string, unknown> {
  return decodeJsonb(event.payload) as Record<string, unknown>;
}

/**
 * A minimal knex-alike that only accepts `file_audit_events`. Use for unit
 * tests of the emitter itself.
 */
export function createAuditCapture() {
  const events: CapturedAuditEvent[] = [];
  const tx: any = (table: string) => {
    if (table !== 'file_audit_events') {
      throw new Error(`Unexpected table access: ${table}`);
    }
    return {
      insert: async (row: CapturedAuditEvent) => {
        events.push(row);
        return [row];
      },
    };
  };
  tx.raw = (sql: string, bindings: unknown[] = []) => ({ __raw: sql, bindings });
  return { tx, events };
}

/**
 * Wrap an existing strict-mock table handler so `file_audit_events` writes are
 * captured instead of throwing `Unexpected table access`. Lets a service-level
 * test keep its narrow allowlist while still asserting on emitted provenance.
 */
export function withAuditCapture<T extends (table: string) => unknown>(handler: T) {
  const events: CapturedAuditEvent[] = [];
  const wrapped: any = (table: string) => {
    if (table === 'file_audit_events') {
      return {
        insert: async (row: CapturedAuditEvent) => {
          events.push(row);
          return [row];
        },
      };
    }
    return handler(table);
  };
  wrapped.raw = (sql: string, bindings: unknown[] = []) => ({ __raw: sql, bindings });
  return { db: wrapped, events };
}
