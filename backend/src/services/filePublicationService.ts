import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { Knex } from 'knex';

import { ConflictError, NotFoundError } from '../errors';
import { getBackendEnv } from '../config/env';
import type { DatabaseService } from './databaseService';
import type { FileService } from './fileService';
import type { WorkspaceService } from './workspaceService';
import { ObjectStoreError, type ObjectStore } from './objectStore';
import { getPublicationObjectStore } from './objectStoreFactory';
import {
  buildProvenanceName,
  buildPublicationKey,
  buildPublishedName,
  buildTargetUri,
} from './filePublicationNaming';

/**
 * Exports an approved file to the publication bucket as an immutable artifact.
 *
 * Each publish writes a new, never-before-used key rather than replacing the
 * previous one, so an earlier release stays byte-for-byte retrievable. Nothing
 * here mutates a file's status — that wiring lives in the status service — so
 * the object write can be exercised and proven on its own.
 */

export interface PublishedArtifact {
  id: string;
  fileId: number;
  workspaceId: string;
  publicationVersion: number;
  sourcePath: string;
  publishedName: string;
  targetBucket: string;
  targetKey: string;
  targetUri: string;
  sha256: string;
  sizeBytes: number;
  /** True when the object already existed with identical content. */
  reused: boolean;
}

export interface WriteArtifactResult {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  reused: boolean;
}

export const hashBuffer = (payload: Buffer): string =>
  createHash('sha256').update(payload).digest('hex');

/**
 * Writes an object that must never be overwritten.
 *
 * `ifAbsent` maps to a create-only precondition, so a second writer racing for
 * the same key fails rather than clobbering. A conflict is not automatically an
 * error though: an interrupted publish retried with identical bytes should
 * succeed, while the same key holding *different* content is a genuine clash.
 */
export async function writeImmutableArtifact(
  store: ObjectStore,
  key: string,
  payload: Buffer,
  options: { mimeType?: string; customMetadata?: Record<string, string> },
): Promise<WriteArtifactResult> {
  const sha256 = hashBuffer(payload);
  try {
    await store.putStream(key, Readable.from(payload), {
      mimeType: options.mimeType,
      contentLength: payload.length,
      sha256,
      customMetadata: options.customMetadata,
      ifAbsent: true,
    });
    return { objectKey: key, sha256, sizeBytes: payload.length, reused: false };
  } catch (error) {
    if (!(error instanceof ObjectStoreError) || error.code !== 'CONFLICT') throw error;

    const existing = await store.head(key).catch(() => null);
    if (existing?.integrity.sha256 === sha256) {
      // Same key, same bytes: a retry of a publish that was interrupted after
      // the upload but before it was recorded. Treat as done.
      return { objectKey: key, sha256, sizeBytes: payload.length, reused: true };
    }
    throw new ConflictError(
      `A different artifact already exists at ${key}; refusing to overwrite an immutable object`,
    );
  }
}

export class FilePublicationService {
  private readonly db: Knex;
  private readonly store: ObjectStore;

  constructor(
    databaseService: DatabaseService,
    private readonly fileService: FileService,
    private readonly workspaceService: WorkspaceService,
    store?: ObjectStore,
  ) {
    this.db = databaseService.getDb();
    this.store = store || getPublicationObjectStore();
  }

  /** Next version for this file. Only ever increases, including after withdrawal. */
  private async nextPublicationVersion(fileId: number, tx?: Knex): Promise<number> {
    const row = await (tx || this.db)('file_publications')
      .where({ fileId })
      .max('publicationVersion as latest')
      .first();
    return Number(row?.latest ?? 0) + 1;
  }

  async listPublications(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    return this.db('file_publications').where({ fileId }).orderBy('publicationVersion', 'asc');
  }

  async getPublication(fileId: number, publicationVersion: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    const publication = await this.db('file_publications')
      .where({ fileId, publicationVersion })
      .first();
    if (!publication) throw new NotFoundError('Publication not found');
    return publication;
  }

  /** Streams a published artifact back through the API rather than exposing the bucket. */
  async getPublicationDownload(fileId: number, publicationVersion: number, userId: string) {
    const publication = await this.getPublication(fileId, publicationVersion, userId);
    const object = await this.store.getStream(String(publication.targetKey));
    return {
      stream: object.stream,
      mimeType: String(publication.mimeType || 'application/octet-stream'),
      sizeBytes: Number(publication.sizeBytes || 0),
      downloadName: String(publication.publishedName).split('/').pop() || 'artifact',
    };
  }

  /**
   * Exports the file's current content and records where it went.
   *
   * Objects are written before the database row, mirroring how file versions
   * are committed: an orphaned object is recoverable, a row pointing at an
   * object that does not exist is not.
   */
  async publishArtifact(
    fileId: number,
    userId: string,
    options?: { provenance?: unknown; tx?: Knex.Transaction },
  ): Promise<PublishedArtifact> {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });

    const config = getBackendEnv().objectStore.publication;
    const publicationVersion = await this.nextPublicationVersion(fileId);
    const sourcePath = String(file.name);
    const publishedName = buildPublishedName(sourcePath, publicationVersion);
    const targetKey = buildPublicationKey({
      prefix: config.prefix,
      workspaceId: String(file.workspaceId),
      publishedName,
    });

    const payload = await this.fileService.readFileBuffer(file);
    const mimeType = String(file.mimeType || 'application/octet-stream');
    const written = await writeImmutableArtifact(this.store, targetKey, payload, {
      mimeType,
      // Stamped so the artifact is self-describing if the database is ever lost.
      customMetadata: {
        'helpudoc-file-id': String(fileId),
        'helpudoc-workspace-id': String(file.workspaceId),
        'helpudoc-publication-version': String(publicationVersion),
        'helpudoc-source-version': String(file.version ?? 0),
        'helpudoc-published-by': String(userId),
      },
    });

    let provenanceKey: string | null = null;
    let provenanceSha256: string | null = null;
    if (options?.provenance !== undefined) {
      const document = Buffer.from(JSON.stringify(options.provenance, null, 2), 'utf8');
      const key = buildPublicationKey({
        prefix: config.prefix,
        workspaceId: String(file.workspaceId),
        publishedName: buildProvenanceName(publishedName),
      });
      const provenanceWrite = await writeImmutableArtifact(this.store, key, document, {
        mimeType: 'application/json',
      });
      provenanceKey = provenanceWrite.objectKey;
      provenanceSha256 = provenanceWrite.sha256;
    }

    const record = {
      id: randomUUID(),
      fileId,
      workspaceId: String(file.workspaceId),
      publicationVersion,
      sourcePath,
      publishedName,
      targetProvider: config.provider,
      targetBucket: config.bucketName,
      targetKey,
      targetUri: buildTargetUri(config.provider, config.bucketName, targetKey),
      sourceFileVersionId: file.currentVersionId ?? null,
      sourceFileVersion: Number(file.version ?? 0),
      sha256: written.sha256,
      sizeBytes: written.sizeBytes,
      mimeType,
      provenanceKey,
      provenanceSha256,
      publishedByUserId: userId,
    };

    const runner = options?.tx || this.db;
    try {
      await runner('file_publications').insert(record);
    } catch (error) {
      // The object is immutable and cannot be rolled back into nothing, but an
      // unreferenced key is harmless: a retry hits the CONFLICT path above,
      // matches on hash, and proceeds.
      throw error;
    }

    return {
      id: record.id,
      fileId,
      workspaceId: record.workspaceId,
      publicationVersion,
      sourcePath,
      publishedName,
      targetBucket: record.targetBucket,
      targetKey,
      targetUri: record.targetUri,
      sha256: written.sha256,
      sizeBytes: written.sizeBytes,
      reused: written.reused,
    };
  }
}
