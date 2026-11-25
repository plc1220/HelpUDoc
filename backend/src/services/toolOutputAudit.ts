import { createHash } from 'crypto';
import { Storage } from '@google-cloud/storage';
import { safeErrorForLog } from '../lib/safeError';

/**
 * Full tool outputs for audit, kept out of the chat.
 *
 * Message metadata and telemetry now keep only a 2,000-character preview of each tool
 * output (lib/toolEventSummary.ts). The audit policy still needs the complete output, so
 * each tool_end / tool_error is written to its own object in TOOL_OUTPUT_AUDIT_BUCKET.
 * Code-running tools also write their full input (the code itself) on tool_start, as
 * <index>-<tool>.input.txt next to the output, so an auditor can see exactly what ran.
 * Nothing in the chat reads these objects; only auditors do.
 *
 * Uploads run in the background so runs never wait on them. A small queue bounds
 * concurrency and pending bytes, so a burst of large reads cannot fill the backend heap.
 * A write that still fails after retries is logged as an audit gap.
 *
 * Disabled when TOOL_OUTPUT_AUDIT_BUCKET is unset: behaviour is then as before.
 */

export type ToolOutputAuditRecord = {
  runId: string;
  eventIndex: number;
  workspaceId: string;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  toolName: string;
  eventType: 'start' | 'end' | 'error';
  eventAt: string;
  content: string;
};

export type ToolOutputAuditStored = { key: string; sha256: string; bytes: number };

/**
 * Create-only write. The backend's identity may create objects in the audit bucket but
 * not read, overwrite or delete them, so the writer never reads the object back.
 * Rejects with { code: 'CONFLICT' } when the object already exists.
 */
export type AuditObjectWriter = {
  create(key: string, body: Buffer, options: { contentType: string; metadata: Record<string, string> }): Promise<void>;
};

type Logger = Pick<Console, 'warn' | 'error'>;

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_PENDING_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ATTEMPTS = 3;

export function toolOutputAuditKey(
  record: Pick<ToolOutputAuditRecord, 'workspaceId' | 'runId' | 'eventIndex' | 'toolName'> & { eventType?: ToolOutputAuditRecord['eventType'] },
): string {
  const tool = record.toolName.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'tool';
  const index = String(record.eventIndex).padStart(5, '0');
  const suffix = record.eventType === 'start' ? '.input.txt' : '.txt';
  return `tool-outputs/${record.workspaceId}/${record.runId}/${index}-${tool}${suffix}`;
}

/**
 * Removes auditInput (the full input of a code-running tool) from a parsed stream event,
 * so it never reaches the stream or stored metadata. Returns it only for a tool_start.
 */
export function takeAuditInput(event: Record<string, unknown> | null): string | undefined {
  if (!event || !('auditInput' in event)) return undefined;
  const value = event.auditInput;
  delete event.auditInput;
  return event.type === 'tool_start' && typeof value === 'string' && value ? value : undefined;
}

type QueueItem = { record: ToolOutputAuditRecord; body: Buffer; sha256: string };

export class ToolOutputAuditQueue {
  private readonly pending: QueueItem[] = [];
  private pendingBytes = 0;
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly writer: AuditObjectWriter,
    private readonly onStored: (record: ToolOutputAuditRecord, stored: ToolOutputAuditStored) => Promise<void>,
    private readonly options: {
      concurrency?: number;
      maxPendingBytes?: number;
      attempts?: number;
      retryDelayMs?: number;
      logger?: Logger;
    } = {},
  ) {}

  /** Queues one output. Returns false, and logs an audit gap, when it cannot be queued. */
  enqueue(record: ToolOutputAuditRecord): boolean {
    const body = Buffer.from(record.content, 'utf8');
    const maxPending = this.options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    if (this.pendingBytes + body.length > maxPending) {
      this.gap(record, body.length, 'queue full');
      return false;
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    this.pending.push({ record, body, sha256 });
    this.pendingBytes += body.length;
    this.pump();
    return true;
  }

  /** Resolves when every queued upload has finished (tests and shutdown). */
  idle(): Promise<void> {
    if (!this.pending.length && !this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    const concurrency = this.options.concurrency ?? DEFAULT_CONCURRENCY;
    while (this.active < concurrency && this.pending.length) {
      const item = this.pending.shift()!;
      this.active += 1;
      void this.upload(item).finally(() => {
        this.active -= 1;
        this.pendingBytes -= item.body.length;
        this.pump();
        if (!this.pending.length && !this.active) {
          const waiters = this.idleWaiters.splice(0);
          waiters.forEach((resolve) => resolve());
        }
      });
    }
  }

  private async upload(item: QueueItem): Promise<void> {
    const { record, body, sha256 } = item;
    const key = toolOutputAuditKey(record);
    const attempts = this.options.attempts ?? DEFAULT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.writer.create(key, body, {
          contentType: 'text/plain; charset=utf-8',
          metadata: { ...auditMetadata(record), sha256 },
        });
        await this.recordStored(record, { key, sha256, bytes: body.length });
        return;
      } catch (error) {
        // The writer may only create objects. A retry after a lost response finds the
        // object already there: it is stored.
        if ((error as { code?: string })?.code === 'CONFLICT') {
          await this.recordStored(record, { key, sha256, bytes: body.length });
          return;
        }
        if (attempt === attempts) {
          this.gap(record, body.length, 'upload failed', error);
          return;
        }
        await delay((this.options.retryDelayMs ?? 500) * 2 ** (attempt - 1));
      }
    }
  }

  private async recordStored(record: ToolOutputAuditRecord, stored: ToolOutputAuditStored): Promise<void> {
    try {
      await this.onStored(record, stored);
    } catch (error) {
      // The object is stored; only the index row is missing. Its key is derivable.
      (this.options.logger ?? console).warn('Tool output audit stored, but its telemetry row was not updated', {
        runId: record.runId,
        eventIndex: record.eventIndex,
        key: stored.key,
        error: safeErrorForLog(error),
      });
    }
  }

  private gap(record: ToolOutputAuditRecord, bytes: number, reason: string, error?: unknown): void {
    (this.options.logger ?? console).error('Tool output audit gap', {
      reason,
      runId: record.runId,
      eventIndex: record.eventIndex,
      toolName: record.toolName,
      workspaceId: record.workspaceId,
      bytes,
      ...(error ? { error: safeErrorForLog(error) } : {}),
    });
  }
}

function auditMetadata(record: ToolOutputAuditRecord): Record<string, string> {
  const entries: Array<[string, string | undefined]> = [
    ['runId', record.runId],
    ['eventIndex', String(record.eventIndex)],
    ['workspaceId', record.workspaceId],
    ['userId', record.userId],
    ['conversationId', record.conversationId],
    ['turnId', record.turnId],
    ['toolName', record.toolName],
    ['eventType', record.eventType],
    ['eventAt', record.eventAt],
  ];
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let singleton: ToolOutputAuditQueue | null | undefined;

/** The queue for this process, or null when TOOL_OUTPUT_AUDIT_BUCKET is unset. */
export function getToolOutputAuditQueue(
  onStored: (record: ToolOutputAuditRecord, stored: ToolOutputAuditStored) => Promise<void>,
): ToolOutputAuditQueue | null {
  if (singleton !== undefined) return singleton;
  const bucketName = String(process.env.TOOL_OUTPUT_AUDIT_BUCKET || '').trim();
  if (!bucketName) {
    singleton = null;
    return singleton;
  }
  const projectId = String(process.env.TOOL_OUTPUT_AUDIT_GCS_PROJECT_ID || '').trim() || undefined;
  singleton = new ToolOutputAuditQueue(createGcsAuditWriter(bucketName, projectId), onStored);
  return singleton;
}

export function createGcsAuditWriter(bucketName: string, projectId?: string): AuditObjectWriter {
  const bucket = new Storage(projectId ? { projectId } : {}).bucket(bucketName);
  return {
    async create(key, body, options) {
      try {
        await bucket.file(key).save(body, {
          // Large outputs upload in resumable chunks; small ones in one request.
          resumable: body.length > 8 * 1024 * 1024,
          validation: 'crc32c',
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: options.contentType, metadata: options.metadata },
        });
      } catch (error) {
        const status = Number((error as { code?: number | string })?.code || 0);
        if (status === 412 || status === 409) {
          throw Object.assign(new Error(`Audit object already exists: ${key}`), { code: 'CONFLICT' });
        }
        throw error;
      }
    },
  };
}
