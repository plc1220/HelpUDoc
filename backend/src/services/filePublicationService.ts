import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { Knex } from 'knex';

import { ConflictError, NotFoundError } from '../errors';
import { getBackendEnv } from '../config/env';
import type { DatabaseService } from './databaseService';
import type { FileService } from './fileService';
import type { WorkspaceService } from './workspaceService';
import type { GoogleDriveService } from './googleDriveService';
import { decryptOAuthSecret, encryptOAuthSecret } from './userOAuthTokenService';
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

  async deliverToGoogleDrive(
    fileId: number,
    publicationVersion: number,
    userId: string,
    driveService: GoogleDriveService,
  ) {
    const publication = await this.getPublication(fileId, publicationVersion, userId);
    const current = await this.db('file_publication_deliveries')
      .where({ publicationId: publication.id }).first();
    if (current?.status === 'delivered') return this.toDriveDeliveryResponse(current);

    let delivery = current;
    if (!delivery) {
      const driveFileId = await driveService.generateUploadId(userId);
      const candidate = {
        id: randomUUID(), publicationId: publication.id, fileId,
        workspaceId: String(publication.workspaceId), driveFileId,
        status: 'pending', sha256: String(publication.sha256), deliveredByUserId: userId,
      };
      try {
        await this.db('file_publication_deliveries').insert(candidate);
        delivery = candidate;
      } catch (error) {
        // Another request may have reserved the same publication while the ID
        // was being generated. Continue with its persisted ID.
        delivery = await this.db('file_publication_deliveries')
          .where({ publicationId: publication.id }).first();
        if (!delivery) throw error;
      }
    }
    if (delivery.status !== 'delivered' && String(delivery.deliveredByUserId || '') !== userId) {
      throw new ConflictError('This Drive delivery is pending under another Google account; ask that publisher to retry it');
    }

    const object = await this.store.getStream(String(publication.targetKey));
    const expectedSize = Number(publication.sizeBytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new ConflictError('The archived publication has an invalid size');
    }
    const buffer = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    for await (const chunk of object.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (offset + bytes.length > buffer.length) throw new ConflictError('The archived publication size did not match its record');
      bytes.copy(buffer, offset);
      offset += bytes.length;
    }
    if (offset !== expectedSize) throw new ConflictError('The archived publication size did not match its record');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (sha256 !== String(publication.sha256)) {
      throw new ConflictError('The archived publication failed its SHA-256 integrity check');
    }
    const uploaded = await driveService.uploadPublishedArtifact(userId, {
      driveFileId: String(delivery.driveFileId),
      name: String(publication.publishedName).split('/').pop() || 'published-file',
      mimeType: String(publication.mimeType || 'application/octet-stream'),
      buffer,
      publicationId: String(publication.id),
      uploadSessionUri: delivery.uploadSessionUri ? decryptOAuthSecret(String(delivery.uploadSessionUri)) : null,
      onUploadSession: async (uri) => {
        await this.db('file_publication_deliveries').where({ id: delivery!.id }).update({
          uploadSessionUri: encryptOAuthSecret(uri), updatedAt: this.db.fn.now(),
        });
      },
    });
    await this.db('file_publication_deliveries').where({ id: delivery.id }).update({
      status: 'delivered', webViewLink: uploaded.webViewLink || null,
      uploadSessionUri: null, updatedAt: this.db.fn.now(),
    });
    const completed = await this.db('file_publication_deliveries').where({ id: delivery.id }).first();
    return this.toDriveDeliveryResponse(completed);
  }

  private toDriveDeliveryResponse(row: any) {
    if (!row) return null;
    return {
      id: row.id,
      fileId: row.fileId,
      workspaceId: row.workspaceId,
      driveFileId: row.driveFileId,
      webViewLink: row.webViewLink || null,
      status: row.status,
      deliveredByUserId: row.deliveredByUserId || null,
      createdAt: row.createdAt,
    };
  }

  async deliverCurrentToGoogleDrive(fileId: number, userId: string, driveService: GoogleDriveService) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    if (String(file.status) !== 'published' || !file.currentPublicationId) {
      throw new ConflictError('Publish this file before delivering it to Google Drive');
    }
    const publication = await this.db('file_publications').where({ id: file.currentPublicationId }).first();
    if (!publication) throw new NotFoundError('Current publication not found');
    return this.deliverToGoogleDrive(fileId, Number(publication.publicationVersion), userId, driveService);
  }

  async getCurrentGoogleDriveDelivery(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    if (String(file.status) !== 'published' || !file.currentPublicationId) return null;
    const delivery = await this.db('file_publication_deliveries')
      .select('id', 'fileId', 'workspaceId', 'driveFileId', 'webViewLink', 'status', 'deliveredByUserId', 'createdAt')
      .where({ publicationId: file.currentPublicationId }).first();
    return this.toDriveDeliveryResponse(delivery);
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
