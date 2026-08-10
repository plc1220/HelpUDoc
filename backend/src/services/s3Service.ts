import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getBackendEnv, type BackendEnv } from '../config/env';
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

type S3Config = BackendEnv['s3'];

export interface S3ServiceOptions {
  config?: S3Config;
  /** Injection points keep provider contract tests independent of a live object store. */
  client?: S3Client;
  publicClient?: S3Client;
}

function cleanEtag(value: string | undefined): string | null {
  return value?.replace(/^"|"$/g, '') || null;
}

function metadataFromS3(
  bucket: string,
  key: string,
  response: HeadObjectCommandOutput | GetObjectCommandOutput,
): ObjectMetadata {
  const customMetadata = Object.fromEntries(
    Object.entries(response.Metadata || {}).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
  return {
    key,
    bucket,
    sizeBytes: Number(response.ContentLength || 0),
    mimeType: response.ContentType || null,
    etag: cleanEtag(response.ETag),
    lastModified: response.LastModified || null,
    providerVersion: response.VersionId || null,
    integrity: {
      sha256: normalizeSha256(customMetadata[HELPUDOC_SHA256_METADATA_KEY], 's3'),
      providerChecksum: response.ChecksumSHA256 || null,
    },
    customMetadata,
  };
}

function mapS3Error(error: unknown, message: string): ObjectStoreError {
  if (error instanceof ObjectStoreError) {
    return error;
  }
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = String(candidate?.name || candidate?.Code || candidate?.code || '');
  const status = Number(candidate?.$metadata?.httpStatusCode || 0);
  if (status === 404 || name === 'NotFound' || name === 'NoSuchKey' || name === 'NoSuchBucket') {
    return new ObjectStoreError({ code: 'NOT_FOUND', provider: 's3', message, cause: error });
  }
  if (status === 409 || status === 412 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') {
    return new ObjectStoreError({ code: 'CONFLICT', provider: 's3', message, cause: error });
  }
  if (status === 401 || status === 403 || name === 'AccessDenied') {
    return new ObjectStoreError({ code: 'FORBIDDEN', provider: 's3', message, cause: error });
  }
  const retryable = status === 408 || status === 429 || status >= 500
    || ['TimeoutError', 'RequestTimeout', 'SlowDown', 'ECONNRESET', 'ECONNREFUSED'].includes(name);
  return new ObjectStoreError({
    code: retryable ? 'UNAVAILABLE' : 'UNKNOWN',
    provider: 's3',
    message,
    retryable,
    cause: error,
  });
}

export class S3Service implements ObjectStore {
  readonly provider = 's3' as const;
  readonly bucketName: string;

  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private bucketReadyPromise: Promise<void> | null = null;

  constructor(options: S3ServiceOptions = {}) {
    const s3 = options.config || getBackendEnv().s3;
    this.bucketName = s3.bucketName;
    const clientOptions = {
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = options.client || new S3Client({ ...clientOptions, endpoint: s3.endpoint });
    this.publicClient = options.publicClient
      || new S3Client({ ...clientOptions, endpoint: s3.publicEndpoint });
  }

  private async ensureBucketExists(): Promise<void> {
    if (!this.bucketReadyPromise) {
      this.bucketReadyPromise = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
        } catch (error: unknown) {
          const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
          const code = String(candidate?.Code || candidate?.name || '');
          const status = Number(candidate?.$metadata?.httpStatusCode || 0);
          const shouldCreate = code === 'NotFound' || code === 'NoSuchBucket' || status === 404;
          if (!shouldCreate) {
            throw error;
          }
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucketName }));
        }
      })().catch((error) => {
        this.bucketReadyPromise = null;
        throw mapS3Error(error, `Unable to prepare object-store bucket ${this.bucketName}`);
      });
    }
    await this.bucketReadyPromise;
  }

  async putStream(
    key: string,
    source: Readable,
    options: PutObjectOptions = {},
  ): Promise<ObjectWriteResult> {
    await this.ensureBucketExists();
    const expectedSha256 = normalizeSha256(options.sha256, 's3');
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
    try {
      const uploadPromise = this.client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: hashingStream,
        ContentType: options.mimeType,
        ContentLength: options.contentLength,
        Metadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
        IfNoneMatch: options.ifAbsent ? '*' : undefined,
      }));
      const [, result] = await Promise.all([
        pipeline(source, hashingStream),
        uploadPromise,
      ]);
      const sha256 = hash.digest('hex');
      if (expectedSha256 && sha256 !== expectedSha256) {
        await this.delete(key, { ignoreMissing: true }).catch(() => undefined);
        throw new ObjectStoreError({
          code: 'INTEGRITY_FAILURE',
          provider: 's3',
          message: `SHA-256 mismatch while writing object ${key}`,
        });
      }
      if (options.contentLength !== undefined && sizeBytes !== options.contentLength) {
        await this.delete(key, { ignoreMissing: true }).catch(() => undefined);
        throw new ObjectStoreError({
          code: 'INTEGRITY_FAILURE',
          provider: 's3',
          message: `Content length mismatch while writing object ${key}`,
        });
      }
      return {
        key,
        bucket: this.bucketName,
        sizeBytes,
        mimeType: options.mimeType || null,
        etag: cleanEtag(result.ETag),
        lastModified: null,
        providerVersion: result.VersionId || null,
        integrity: {
          sha256,
          providerChecksum: result.ChecksumSHA256 || null,
        },
        customMetadata,
      };
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to write object ${key}`);
    }
  }

  async getStream(key: string, options: GetObjectOptions = {}): Promise<ObjectReadResult> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        VersionId: options.providerVersion,
      }));
      if (!response.Body) {
        throw new ObjectStoreError({
          code: 'NOT_FOUND',
          provider: 's3',
          message: `Object ${key} has no readable body`,
        });
      }
      const stream = response.Body instanceof Readable
        ? response.Body
        : Readable.from(response.Body as AsyncIterable<Uint8Array>);
      return { stream, metadata: metadataFromS3(this.bucketName, key, response) };
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to read object ${key}`);
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
      throw mapS3Error(error, `Unable to materialize object ${key}`);
    }
  }

  async head(key: string, options: GetObjectOptions = {}): Promise<ObjectMetadata> {
    try {
      const response = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        VersionId: options.providerVersion,
      }));
      return metadataFromS3(this.bucketName, key, response);
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to inspect object ${key}`);
    }
  }

  async delete(key: string, options: DeleteObjectOptions = {}): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        VersionId: options.providerVersion,
      }));
    } catch (error: unknown) {
      const mapped = mapS3Error(error, `Unable to delete object ${key}`);
      if (options.ignoreMissing && mapped.code === 'NOT_FOUND') {
        return;
      }
      throw mapped;
    }
  }

  async signUpload(key: string, options: SignUploadOptions): Promise<SignedObjectRequest> {
    await this.ensureBucketExists();
    try {
      const sha256 = normalizeSha256(options.sha256, 's3');
      const url = await getSignedUrl(
        this.publicClient,
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ContentType: options.mimeType,
          Metadata: sha256 ? { [HELPUDOC_SHA256_METADATA_KEY]: sha256 } : undefined,
          IfNoneMatch: options.ifAbsent ? '*' : undefined,
        }),
        { expiresIn: options.expiresInSeconds },
      );
      return {
        url,
        method: 'PUT',
        headers: {
          'content-type': options.mimeType,
          ...(options.ifAbsent ? { 'if-none-match': '*' } : {}),
          ...(sha256 ? { [`x-amz-meta-${HELPUDOC_SHA256_METADATA_KEY}`]: sha256 } : {}),
        },
      };
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to sign upload for object ${key}`);
    }
  }

  async signDownload(key: string, options: SignDownloadOptions): Promise<SignedObjectRequest> {
    try {
      const url = await getSignedUrl(
        this.publicClient,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          VersionId: options.providerVersion,
          ResponseContentDisposition: options.downloadName
            ? `attachment; filename="${options.downloadName.replace(/["\\\r\n]/g, '_')}"`
            : undefined,
        }),
        { expiresIn: options.expiresInSeconds },
      );
      return { url, method: 'GET', headers: {} };
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to sign download for object ${key}`);
    }
  }

  // Compatibility surface for existing callers. New code should use ObjectStore methods.
  async uploadFile(
    workspaceName: string,
    fileName: string,
    fileStream: Buffer,
    mimeType?: string,
    keyOverride?: string,
  ) {
    const key = keyOverride || `${workspaceName}/${fileName.replace(/\\/g, '/')}`;
    const result = await this.putStream(key, Readable.from(fileStream), {
      mimeType,
      contentLength: fileStream.length,
    });
    return {
      Key: result.key,
      Bucket: result.bucket,
      ETag: result.etag,
      VersionId: result.providerVersion,
      ChecksumSHA256: result.integrity.providerChecksum,
    };
  }

  async getFile(key: string): Promise<Buffer> {
    const { stream } = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async createPresignedUploadUrl(key: string, mimeType: string, expiresInSeconds: number): Promise<string> {
    return (await this.signUpload(key, { mimeType, expiresInSeconds })).url;
  }

  async headFile(key: string): Promise<{ sizeBytes: number; mimeType: string | null; etag: string | null }> {
    const result = await this.head(key);
    return { sizeBytes: result.sizeBytes, mimeType: result.mimeType, etag: result.etag };
  }

  async downloadFileToPath(key: string, destinationPath: string): Promise<void> {
    await this.downloadToPath(key, destinationPath);
  }

  deleteFile(key: string): Promise<void> {
    return this.delete(key);
  }

  async copyFile(oldKey: string, newKey: string): Promise<void> {
    await this.ensureBucketExists();
    const encodedSource = encodeURIComponent(oldKey).replace(/%2F/g, '/');
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `/${this.bucketName}/${encodedSource}`,
        Key: newKey,
      }));
    } catch (error: unknown) {
      throw mapS3Error(error, `Unable to copy object ${oldKey}`);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      try {
        const listResponse = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        const keys = (listResponse.Contents || [])
          .map((item) => item.Key)
          .filter((key): key is string => Boolean(key));
        if (keys.length > 0) {
          await this.client.send(new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
          }));
        }
        continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
      } catch (error: unknown) {
        throw mapS3Error(error, `Unable to delete object prefix ${prefix}`);
      }
    } while (continuationToken);
  }
}
