import { Storage, type File, type StorageOptions } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  HELPUDOC_SHA256_METADATA_KEY,
  ObjectStoreError,
  normalizeSha256,
  type DeleteObjectOptions,
  type GetObjectOptions,
  type ObjectMetadata,
  type ObjectReadResult,
  type ObjectStore,
  type ObjectWriteResult,
  type PutObjectOptions,
  type SignDownloadOptions,
  type SignUploadOptions,
  type SignedObjectRequest,
} from './objectStore';

export interface GcsObjectStoreOptions {
  bucketName: string;
  projectId?: string;
  keyFilename?: string;
  apiEndpoint?: string;
  /** Injection point for provider contract tests and local failure simulation. */
  storage?: Storage;
}

type GcsMetadata = {
  name?: string;
  bucket?: string;
  size?: string | number;
  contentType?: string;
  etag?: string;
  updated?: string;
  generation?: string | number;
  crc32c?: string;
  md5Hash?: string;
  metadata?: Record<string, string | undefined>;
};

function metadataFromGcs(defaultBucket: string, key: string, metadata: GcsMetadata): ObjectMetadata {
  const customMetadata = Object.fromEntries(
    Object.entries(metadata.metadata || {}).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
  const lastModified = metadata.updated ? new Date(metadata.updated) : null;
  return {
    key: metadata.name || key,
    bucket: metadata.bucket || defaultBucket,
    sizeBytes: Number(metadata.size || 0),
    mimeType: metadata.contentType || null,
    etag: metadata.etag || null,
    lastModified: lastModified && !Number.isNaN(lastModified.valueOf()) ? lastModified : null,
    providerVersion: metadata.generation ? String(metadata.generation) : null,
    integrity: {
      sha256: normalizeSha256(customMetadata[HELPUDOC_SHA256_METADATA_KEY], 'gcs'),
      providerChecksum: metadata.crc32c || metadata.md5Hash || null,
    },
    customMetadata,
  };
}

function mapGcsError(error: unknown, message: string): ObjectStoreError {
  if (error instanceof ObjectStoreError) {
    return error;
  }
  const candidate = error as { code?: number | string; statusCode?: number; errors?: Array<{ reason?: string }> };
  const status = Number(candidate?.statusCode || candidate?.code || 0);
  const reason = String(candidate?.errors?.[0]?.reason || candidate?.code || '');
  if (status === 404 || reason === 'notFound') {
    return new ObjectStoreError({ code: 'NOT_FOUND', provider: 'gcs', message, cause: error });
  }
  if (status === 409 || status === 412 || reason === 'conditionNotMet') {
    return new ObjectStoreError({ code: 'CONFLICT', provider: 'gcs', message, cause: error });
  }
  if (status === 400 || reason === 'invalid') {
    return new ObjectStoreError({ code: 'INVALID_REQUEST', provider: 'gcs', message, cause: error });
  }
  if (status === 401 || status === 403 || reason === 'forbidden') {
    return new ObjectStoreError({ code: 'FORBIDDEN', provider: 'gcs', message, cause: error });
  }
  const retryable = status === 408 || status === 429 || status >= 500
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(reason);
  return new ObjectStoreError({
    code: retryable ? 'UNAVAILABLE' : 'UNKNOWN',
    provider: 'gcs',
    message,
    retryable,
    cause: error,
  });
}

export class GcsObjectStore implements ObjectStore {
  readonly provider = 'gcs' as const;
  readonly bucketName: string;

  private readonly storage: Storage;

  constructor(options: GcsObjectStoreOptions) {
    this.bucketName = options.bucketName;
    const storageOptions: StorageOptions = {
      projectId: options.projectId,
      keyFilename: options.keyFilename,
      apiEndpoint: options.apiEndpoint,
    };
    this.storage = options.storage || new Storage(storageOptions);
  }

  private file(key: string, options: GetObjectOptions = {}): File {
    return this.storage.bucket(this.bucketName).file(
      key,
      options.providerVersion ? { generation: options.providerVersion } : undefined,
    );
  }

  async putStream(
    key: string,
    source: Readable,
    options: PutObjectOptions = {},
  ): Promise<ObjectWriteResult> {
    const expectedSha256 = normalizeSha256(options.sha256, 'gcs');
    const customMetadata: Record<string, string> = { ...options.customMetadata };
    if (expectedSha256) {
      customMetadata[HELPUDOC_SHA256_METADATA_KEY] = expectedSha256;
    }
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const hashingStream = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        sizeBytes += bytes.length;
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    const file = this.file(key);
    try {
      await pipeline(
        source,
        hashingStream,
        file.createWriteStream({
          resumable: true,
          validation: 'crc32c',
          metadata: {
            contentType: options.mimeType,
            metadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
          },
          preconditionOpts: options.ifAbsent ? { ifGenerationMatch: 0 } : undefined,
        }),
      );
      const sha256 = hash.digest('hex');
      if (expectedSha256 && sha256 !== expectedSha256) {
        await this.delete(key, { ignoreMissing: true }).catch(() => undefined);
        throw new ObjectStoreError({
          code: 'INTEGRITY_FAILURE',
          provider: 'gcs',
          message: `SHA-256 mismatch while writing object ${key}`,
        });
      }
      if (options.contentLength !== undefined && sizeBytes !== options.contentLength) {
        await this.delete(key, { ignoreMissing: true }).catch(() => undefined);
        throw new ObjectStoreError({
          code: 'INTEGRITY_FAILURE',
          provider: 'gcs',
          message: `Content length mismatch while writing object ${key}`,
        });
      }
      const [metadata] = await file.getMetadata();
      const result = metadataFromGcs(this.bucketName, key, metadata as GcsMetadata);
      return { ...result, sizeBytes, integrity: { ...result.integrity, sha256 } };
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to write object ${key}`);
    }
  }

  async getStream(key: string, options: GetObjectOptions = {}): Promise<ObjectReadResult> {
    try {
      const requestedFile = this.file(key, options);
      const [rawMetadata] = await requestedFile.getMetadata();
      const metadata = metadataFromGcs(this.bucketName, key, rawMetadata as GcsMetadata);
      const pinnedFile = metadata.providerVersion
        ? this.file(key, { providerVersion: metadata.providerVersion })
        : requestedFile;
      return { stream: pinnedFile.createReadStream(), metadata };
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to read object ${key}`);
    }
  }

  async downloadToPath(
    key: string,
    destinationPath: string,
    options: GetObjectOptions = {},
  ): Promise<ObjectMetadata> {
    const result = await this.getStream(key, options);
    try {
      await pipeline(result.stream, createWriteStream(destinationPath, { flags: 'wx' }));
      return result.metadata;
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to materialize object ${key}`);
    }
  }

  async head(key: string, options: GetObjectOptions = {}): Promise<ObjectMetadata> {
    try {
      const [metadata] = await this.file(key, options).getMetadata();
      return metadataFromGcs(this.bucketName, key, metadata as GcsMetadata);
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to inspect object ${key}`);
    }
  }

  async delete(key: string, options: DeleteObjectOptions = {}): Promise<void> {
    try {
      await this.file(key, options).delete({ ignoreNotFound: options.ignoreMissing });
    } catch (error: unknown) {
      const mapped = mapGcsError(error, `Unable to delete object ${key}`);
      if (options.ignoreMissing && mapped.code === 'NOT_FOUND') {
        return;
      }
      throw mapped;
    }
  }

  async signUpload(key: string, options: SignUploadOptions): Promise<SignedObjectRequest> {
    try {
      const sha256 = normalizeSha256(options.sha256, 'gcs');
      const [url] = await this.file(key).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + options.expiresInSeconds * 1000,
        contentType: options.mimeType,
        extensionHeaders: sha256
          ? { [`x-goog-meta-${HELPUDOC_SHA256_METADATA_KEY}`]: sha256 }
          : undefined,
        queryParams: options.ifAbsent
          ? { ifGenerationMatch: '0' }
          : undefined,
      });
      return {
        url,
        method: 'PUT',
        headers: {
          'content-type': options.mimeType,
          ...(sha256 ? { [`x-goog-meta-${HELPUDOC_SHA256_METADATA_KEY}`]: sha256 } : {}),
        },
      };
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to sign upload for object ${key}`);
    }
  }

  async signDownload(key: string, options: SignDownloadOptions): Promise<SignedObjectRequest> {
    try {
      const [url] = await this.file(key, options).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + options.expiresInSeconds * 1000,
        responseDisposition: options.downloadName
          ? `attachment; filename="${options.downloadName.replace(/["\\\r\n]/g, '_')}"`
          : undefined,
      });
      return { url, method: 'GET', headers: {} };
    } catch (error: unknown) {
      throw mapGcsError(error, `Unable to sign download for object ${key}`);
    }
  }

}
