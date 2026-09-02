import type { Knex } from 'knex';

import {
  computeEventHash,
  eventTypeForChangeKind,
  resolveActorType,
} from './fileAuditService';
import { isInternalWorkspacePath } from '../lib/workspacePaths';
import type { FileVersionChangeKind } from './fileService';

/**
 * Synthesizes the provenance trail for files that existed before the audit
 * table did.
 *
 * `file_versions` already carries `createdBy`, `changeKind`, `sourceRunId` and
 * `createdAt` for every historical mutation, so the trail can be reconstructed
 * faithfully rather than starting blank at deploy time. Prompts and knowledge
 * refs are unavailable for historical runs — those events carry
 * `backfilled: true` so a reader can tell reconstructed history from recorded
 * history.
 */

export const FILE_AUDIT_BACKFILL_KEY = '2026-08-file-audit-events-backfill-v2';

const FILE_BATCH_SIZE = 200;

export interface BackfillVersionRow {
  id: string;
  fileId: number;
  workspaceId: string;
  version: number;
  name: string;
  sha256?: string | null;
  objectKey?: string | null;
  sizeBytes?: number | string | null;
  changeKind?: string | null;
  baseVersion?: number | null;
  createdBy?: string | null;
  sourceRunId?: string | null;
  operationId?: string | null;
  createdAt?: Date | string | null;
}

export interface BackfillEventRow {
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
  fileVersionId: string;
  fileVersion: number;
  runId: string | null;
  payload: string;
  prevEventHash: string | null;
  eventHash: string;
  occurredAt: Date;
}

/**
 * Pure: turns one file's version history into a correctly-chained event list.
 * Versions are ordered by `version` so the chain matches the real sequence of
 * events, whatever order the rows arrive in.
 */
export function buildBackfillEvents(
  versions: BackfillVersionRow[],
  makeId: () => string,
): { events: BackfillEventRow[]; lastHash: string | null } {
  // Internal storage (`.system/`, `sandbox-runs/`) is never audited: the OKF
  // knowledge bundles alone outnumber real documents by roughly 70:1.
  const auditable = versions.filter((version) => !isInternalWorkspacePath(String(version.name)));
  const ordered = [...auditable].sort((left, right) => Number(left.version) - Number(right.version));
  const events: BackfillEventRow[] = [];
  let prevEventHash: string | null = null;

  ordered.forEach((version, index) => {
    const seq = index + 1;
    const changeKind = (version.changeKind || 'content') as FileVersionChangeKind;
    const actorUserId = version.createdBy ?? null;
    const eventType = eventTypeForChangeKind(changeKind);
    const occurredAt = version.createdAt instanceof Date
      ? version.createdAt
      : new Date(version.createdAt ?? 0);
    const payload = {
      backfilled: true,
      sizeBytes: Number(version.sizeBytes ?? 0),
      baseVersion: version.baseVersion ?? null,
      operationId: version.operationId ?? null,
    };
    const eventHash = computeEventHash({
      prevEventHash,
      fileId: Number(version.fileId),
      seq,
      eventType,
      actorUserId,
      occurredAt,
      payload,
    });

    events.push({
      id: makeId(),
      fileId: Number(version.fileId),
      workspaceId: String(version.workspaceId),
      filePath: String(version.name),
      seq,
      eventType,
      actorUserId,
      actorType: resolveActorType(changeKind, version.sourceRunId),
      sha256: version.sha256 ?? null,
      objectKey: version.objectKey ?? null,
      fileVersionId: String(version.id),
      fileVersion: Number(version.version),
      runId: version.sourceRunId ?? null,
      payload: JSON.stringify(payload),
      prevEventHash,
      eventHash,
      occurredAt,
    });
    prevEventHash = eventHash;
  });

  return { events, lastHash: prevEventHash };
}

export interface BackfillResult {
  alreadyApplied: boolean;
  filesProcessed: number;
  filesSkipped: number;
  eventsWritten: number;
}

export async function backfillFileAuditEvents(
  db: Knex,
  options?: { makeId?: () => string },
): Promise<BackfillResult> {
  const result: BackfillResult = {
    alreadyApplied: false,
    filesProcessed: 0,
    filesSkipped: 0,
    eventsWritten: 0,
  };

  const applied = await db('application_migrations')
    .where({ key: FILE_AUDIT_BACKFILL_KEY })
    .first();
  if (applied) {
    result.alreadyApplied = true;
    return result;
  }

  const makeId = options?.makeId
    ?? (() => (globalThis.crypto as { randomUUID(): string }).randomUUID());

  const fileIdRows = await db('file_versions').distinct('fileId').orderBy('fileId', 'asc');
  const fileIds = fileIdRows.map((row: { fileId: number }) => Number(row.fileId));

  for (let offset = 0; offset < fileIds.length; offset += FILE_BATCH_SIZE) {
    const batch = fileIds.slice(offset, offset + FILE_BATCH_SIZE);

    // Never double-write: a file that already has a trail is left untouched,
    // so a partially-applied run can be resumed safely.
    const existing = await db('file_audit_events').distinct('fileId').whereIn('fileId', batch);
    const alreadyTrailed = new Set(existing.map((row: { fileId: number }) => Number(row.fileId)));
    const pending = batch.filter((fileId) => !alreadyTrailed.has(fileId));
    result.filesSkipped += batch.length - pending.length;
    if (!pending.length) continue;

    const versions = await db('file_versions')
      .whereIn('fileId', pending)
      .orderBy([{ column: 'fileId', order: 'asc' }, { column: 'version', order: 'asc' }]);

    const byFile = new Map<number, BackfillVersionRow[]>();
    for (const version of versions as BackfillVersionRow[]) {
      const key = Number(version.fileId);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(version);
    }

    for (const [fileId, fileVersions] of byFile) {
      const { events, lastHash } = buildBackfillEvents(fileVersions, makeId);
      if (!events.length) continue;
      await db.transaction(async (tx) => {
        await tx('file_audit_events').insert(events);
        await tx('files').where({ id: fileId }).update({
          auditSeq: events.length,
          lastAuditHash: lastHash,
        });
      });
      result.filesProcessed += 1;
      result.eventsWritten += events.length;
    }
  }

  await db('application_migrations')
    .insert({ key: FILE_AUDIT_BACKFILL_KEY })
    .onConflict('key')
    .ignore();

  return result;
}
