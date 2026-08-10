import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Storage } from '@google-cloud/storage';
import { parseBackendEnv } from '../src/config/env';
import { GcsObjectStore } from '../src/services/gcsObjectStore';
import { ObjectStoreError, type ObjectStore } from '../src/services/objectStore';
import { S3Service } from '../src/services/s3Service';

interface StoredObject {
  bytes: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
  generation: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeS3Store(): S3Service {
  const objects = new Map<string, StoredObject>();
  let bucketExists = false;
  const client = {
    async send(command: any): Promise<any> {
      if (command instanceof HeadBucketCommand) {
        if (!bucketExists) {
          throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        return {};
      }
      if (command instanceof CreateBucketCommand) {
        bucketExists = true;
        return {};
      }
      if (command instanceof PutObjectCommand) {
        if (command.input.IfNoneMatch === '*' && objects.has(command.input.Key)) {
          throw Object.assign(new Error('exists'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        objects.set(command.input.Key, {
          bytes,
          contentType: command.input.ContentType,
          metadata: command.input.Metadata || {},
          generation: 's3-v1',
        });
        return { ETag: '"etag-s3"', VersionId: 's3-v1' };
      }
      if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
        const stored = objects.get(command.input.Key);
        if (!stored) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        }
        const common = {
          ContentLength: stored.bytes.length,
          ContentType: stored.contentType,
          Metadata: stored.metadata,
          ETag: '"etag-s3"',
          VersionId: stored.generation,
        };
        return command instanceof GetObjectCommand
          ? { ...common, Body: Readable.from(stored.bytes) }
          : common;
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key);
        return {};
      }
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    },
  } as unknown as S3Client;
  const config = {
    bucketName: 'contract-bucket',
    endpoint: 'http://internal.invalid',
    publicEndpoint: 'http://public.invalid',
    forcePathStyle: true,
    hasCustomEndpoint: true,
    region: 'test-region',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  };
  return new S3Service({ config, client });
}

function makeGcsStore(): GcsObjectStore {
  const objects = new Map<string, StoredObject>();
  let generation = 0;
  const bucket = {
    file(key: string, fileOptions?: { generation?: number }) {
      const requestedGeneration = fileOptions?.generation ? String(fileOptions.generation) : undefined;
      return {
        createWriteStream(options: any) {
          if (options?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(key)) {
            const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
            queueMicrotask(() => stream.destroy(Object.assign(new Error('exists'), { code: 412 })));
            return stream;
          }
          const chunks: Buffer[] = [];
          return new Writable({
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk));
              callback();
            },
            final(callback) {
              generation += 1;
              objects.set(key, {
                bytes: Buffer.concat(chunks),
                contentType: options?.metadata?.contentType,
                metadata: options?.metadata?.metadata || {},
                generation: String(generation),
              });
              callback();
            },
          });
        },
        async getMetadata() {
          const stored = objects.get(key);
          if (!stored || (requestedGeneration && requestedGeneration !== stored.generation)) {
            throw Object.assign(new Error('missing'), { code: 404 });
          }
          return [{
            name: key,
            bucket: 'contract-bucket',
            size: String(stored.bytes.length),
            contentType: stored.contentType,
            metadata: stored.metadata,
            etag: 'etag-gcs',
            generation: stored.generation,
            crc32c: 'crc32c-gcs',
            updated: '2026-08-09T00:00:00.000Z',
          }];
        },
        createReadStream() {
          const stored = objects.get(key);
          if (!stored || (requestedGeneration && requestedGeneration !== stored.generation)) {
            const stream = new Readable({ read() {} });
            queueMicrotask(() => stream.destroy(Object.assign(new Error('missing'), { code: 404 })));
            return stream;
          }
          return Readable.from(stored.bytes);
        },
        async delete(options?: { ignoreNotFound?: boolean }) {
          if (!objects.has(key) && !options?.ignoreNotFound) {
            throw Object.assign(new Error('missing'), { code: 404 });
          }
          objects.delete(key);
        },
        async getSignedUrl(options: { action: string }) {
          return [`https://storage.invalid/${key}?action=${options.action}`];
        },
      };
    },
  };
  const storage = { bucket: () => bucket } as unknown as Storage;
  return new GcsObjectStore({ bucketName: 'contract-bucket', storage });
}

async function assertProviderContract(store: ObjectStore): Promise<void> {
  const payload = Buffer.from(`provider-contract-${store.provider}`);
  const digest = sha256(payload);
  const key = `files/${store.provider}/v1`;
  const written = await store.putStream(key, Readable.from(payload), {
    mimeType: 'application/octet-stream',
    contentLength: payload.length,
    sha256: digest,
    ifAbsent: true,
  });
  assert.equal(written.key, key);
  assert.equal(written.sizeBytes, payload.length);
  assert.equal(written.integrity.sha256, digest);

  const metadata = await store.head(key);
  assert.equal(metadata.integrity.sha256, digest);
  assert.equal(metadata.mimeType, 'application/octet-stream');
  assert.ok(metadata.providerVersion);

  const readResult = await store.getStream(key, { providerVersion: metadata.providerVersion! });
  const chunks: Buffer[] = [];
  for await (const chunk of readResult.stream) {
    chunks.push(Buffer.from(chunk));
  }
  assert.deepEqual(Buffer.concat(chunks), payload);

  const uploadUrl = await store.signUpload(`${key}-signed`, {
    mimeType: 'application/octet-stream',
    expiresInSeconds: 60,
  });
  const downloadUrl = await store.signDownload(key, {
    expiresInSeconds: 60,
    downloadName: 'artifact.bin',
  });
  assert.match(uploadUrl.url, /^https?:\/\//);
  assert.equal(uploadUrl.method, 'PUT');
  assert.equal(uploadUrl.headers['content-type'], 'application/octet-stream');
  assert.match(downloadUrl.url, /^https?:\/\//);
  assert.equal(downloadUrl.method, 'GET');

  const directory = await mkdtemp(path.join(tmpdir(), `helpudoc-${store.provider}-`));
  try {
    const destination = path.join(directory, 'download.bin');
    await store.downloadToPath(key, destination);
    assert.deepEqual(await readFile(destination), payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await assert.rejects(
    store.putStream(key, Readable.from(payload), { ifAbsent: true }),
    (error: unknown) => error instanceof ObjectStoreError && error.code === 'CONFLICT',
  );
  await store.delete(key);
  await assert.rejects(
    store.head(key),
    (error: unknown) => error instanceof ObjectStoreError && error.code === 'NOT_FOUND',
  );
  await store.delete(key, { ignoreMissing: true });
}

test('S3/MinIO adapter satisfies the object-store provider contract', async () => {
  await assertProviderContract(makeS3Store());
});

test('GCS adapter satisfies the object-store provider contract', async () => {
  await assertProviderContract(makeGcsStore());
});

test('providers normalize integrity failures without retaining mismatched objects', async () => {
  for (const store of [makeS3Store(), makeGcsStore()]) {
    await assert.rejects(
      store.putStream('bad-digest', Readable.from('payload'), {
        sha256: '0'.repeat(64),
        contentLength: 7,
      }),
      (error: unknown) => error instanceof ObjectStoreError && error.code === 'INTEGRITY_FAILURE',
    );
    await assert.rejects(
      store.head('bad-digest'),
      (error: unknown) => error instanceof ObjectStoreError && error.code === 'NOT_FOUND',
    );
  }
});

test('object-store provider config defaults to S3 and accepts native GCS', () => {
  assert.equal(parseBackendEnv({}).objectStore.provider, 's3');
  const config = parseBackendEnv({
    OBJECT_STORE_PROVIDER: 'gcs',
    GCS_BUCKET_NAME: 'managed-bucket',
    GOOGLE_CLOUD_PROJECT: 'helpudoc-project',
  }).objectStore;
  assert.deepEqual(config, {
    provider: 'gcs',
    gcs: {
      bucketName: 'managed-bucket',
      projectId: 'helpudoc-project',
      keyFilename: undefined,
      apiEndpoint: undefined,
    },
  });
});
