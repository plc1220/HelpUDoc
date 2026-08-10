import type { Readable } from 'node:stream';

export type ObjectStoreProvider = 's3' | 'gcs';

export type ObjectStoreErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'INTEGRITY_FAILURE'
  | 'UNKNOWN';

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode;
  readonly provider: ObjectStoreProvider;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(input: {
    code: ObjectStoreErrorCode;
    provider: ObjectStoreProvider;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'ObjectStoreError';
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable ?? false;
    this.cause = input.cause;
  }
}

export interface ObjectIntegrity {
  /** Application SHA-256, represented as lowercase hex. */
  sha256: string | null;
  /** Provider checksum, retained for diagnostics rather than application identity. */
  providerChecksum: string | null;
}

export interface ObjectMetadata {
  key: string;
  bucket: string;
  sizeBytes: number;
  mimeType: string | null;
  etag: string | null;
  lastModified: Date | null;
  /** S3 VersionId or GCS generation. Never use this as the HelpUDoc file version. */
  providerVersion: string | null;
  integrity: ObjectIntegrity;
  customMetadata: Readonly<Record<string, string>>;
}

export interface PutObjectOptions {
  mimeType?: string;
  contentLength?: number;
  /** Expected application digest. The adapter persists and verifies it while streaming. */
  sha256?: string;
  customMetadata?: Readonly<Record<string, string>>;
  /** Atomically fail if the object already exists. */
  ifAbsent?: boolean;
}

export interface GetObjectOptions {
  providerVersion?: string;
}

export interface DeleteObjectOptions extends GetObjectOptions {
  /** Treat a missing object as success. */
  ignoreMissing?: boolean;
}

export interface SignUploadOptions {
  mimeType: string;
  expiresInSeconds: number;
  /** Optional client-computed digest, persisted as signed object metadata. */
  sha256?: string;
  ifAbsent?: boolean;
}

export interface SignDownloadOptions extends GetObjectOptions {
  expiresInSeconds: number;
  downloadName?: string;
}

export interface SignedObjectRequest {
  url: string;
  method: 'GET' | 'PUT';
  /** Headers covered by the signature and therefore required on the request. */
  headers: Readonly<Record<string, string>>;
}

export interface ObjectReadResult {
  stream: Readable;
  metadata: ObjectMetadata;
}

export interface ObjectWriteResult extends ObjectMetadata {}

/**
 * Provider-neutral durable object storage boundary.
 *
 * Implementations expose normal Node streams; callers materialize objects on a
 * real local filesystem before passing them to OfficeCLI or sandbox workloads.
 */
export interface ObjectStore {
  readonly provider: ObjectStoreProvider;
  readonly bucketName: string;

  putStream(key: string, source: Readable, options?: PutObjectOptions): Promise<ObjectWriteResult>;
  getStream(key: string, options?: GetObjectOptions): Promise<ObjectReadResult>;
  downloadToPath(key: string, destinationPath: string, options?: GetObjectOptions): Promise<ObjectMetadata>;
  head(key: string, options?: GetObjectOptions): Promise<ObjectMetadata>;
  delete(key: string, options?: DeleteObjectOptions): Promise<void>;
  signUpload(key: string, options: SignUploadOptions): Promise<SignedObjectRequest>;
  signDownload(key: string, options: SignDownloadOptions): Promise<SignedObjectRequest>;
}

export const HELPUDOC_SHA256_METADATA_KEY = 'helpudoc-sha256';

export function normalizeSha256(
  value: string | undefined | null,
  provider: ObjectStoreProvider,
): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ObjectStoreError({
      code: 'INVALID_REQUEST',
      provider,
      message: 'sha256 must be a 64-character hexadecimal digest',
    });
  }
  return normalized;
}
