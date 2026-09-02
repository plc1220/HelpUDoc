import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { ConflictError } from '../src/errors';
import { ObjectStoreError, type ObjectStore } from '../src/services/objectStore';
import { hashBuffer, writeImmutableArtifact } from '../src/services/filePublicationService';

/** A store that behaves like GCS with a create-only precondition. */
function fakeStore(seed: Record<string, Buffer> = {}) {
  const objects = new Map<string, Buffer>(Object.entries(seed));
  const calls: string[] = [];
  const store = {
    provider: 'gcs' as const,
    bucketName: 'published',
    async putStream(key: string, source: Readable, options?: any) {
      calls.push(`put:${key}`);
      if (options?.ifAbsent && objects.has(key)) {
        throw new ObjectStoreError({
          code: 'CONFLICT', provider: 'gcs', message: 'object already exists',
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      return {} as any;
    },
    async head(key: string) {
      calls.push(`head:${key}`);
      const existing = objects.get(key);
      if (!existing) {
        throw new ObjectStoreError({ code: 'NOT_FOUND', provider: 'gcs', message: 'missing' });
      }
      return { integrity: { sha256: hashBuffer(existing), providerChecksum: null } } as any;
    },
    async delete() { /* published artifacts are never deleted */ },
  } as unknown as ObjectStore;
  return { store, objects, calls };
}

const BODY = Buffer.from('# Q3 report\n');

test('a first publish writes the object', async () => {
  const { store, objects } = fakeStore();
  const result = await writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, { mimeType: 'text/markdown' });

  assert.equal(result.reused, false);
  assert.equal(result.sha256, hashBuffer(BODY));
  assert.equal(result.sizeBytes, BODY.length);
  assert.deepEqual(objects.get('ws/q3-v1.md'), BODY);
});

test('re-publishing identical bytes is treated as already done', async () => {
  // A publish interrupted after upload but before the row was written must be
  // safe to retry, not a hard failure.
  const { store, calls } = fakeStore({ 'ws/q3-v1.md': BODY });
  const result = await writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, {});

  assert.equal(result.reused, true, 'the existing object is accepted');
  assert.equal(result.sha256, hashBuffer(BODY));
  assert.deepEqual(calls, ['put:ws/q3-v1.md', 'head:ws/q3-v1.md'], 'conflict is resolved by hashing');
});

test('the same key holding different content is refused', async () => {
  // This is a real clash: overwriting would destroy a published record.
  const { store, objects } = fakeStore({ 'ws/q3-v1.md': Buffer.from('something else') });
  await assert.rejects(
    () => writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, {}),
    (error: unknown) => error instanceof ConflictError
      && /refusing to overwrite an immutable object/.test((error as Error).message),
  );
  assert.deepEqual(objects.get('ws/q3-v1.md'), Buffer.from('something else'), 'left untouched');
});

test('a conflict on a vanished object is still refused rather than silently written', async () => {
  // head() failing after a CONFLICT means we cannot prove the bytes match.
  const store = {
    provider: 'gcs', bucketName: 'published',
    async putStream() {
      throw new ObjectStoreError({ code: 'CONFLICT', provider: 'gcs', message: 'exists' });
    },
    async head() { throw new ObjectStoreError({ code: 'NOT_FOUND', provider: 'gcs', message: 'gone' }); },
  } as unknown as ObjectStore;

  await assert.rejects(
    () => writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, {}),
    (error: unknown) => error instanceof ConflictError,
  );
});

test('errors other than a conflict are not swallowed', async () => {
  const store = {
    provider: 'gcs', bucketName: 'published',
    async putStream() {
      throw new ObjectStoreError({ code: 'UNAVAILABLE', provider: 'gcs', message: 'backend down' });
    },
    async head() { throw new Error('head should not be called'); },
  } as unknown as ObjectStore;

  await assert.rejects(
    () => writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, {}),
    (error: unknown) => error instanceof ObjectStoreError
      && (error as ObjectStoreError).code === 'UNAVAILABLE',
  );
});

test('successive versions occupy separate keys', async () => {
  // The point of versioning in the name: v1 must remain readable after v2.
  const { store, objects } = fakeStore();
  const v1 = Buffer.from('first');
  const v2 = Buffer.from('second');
  await writeImmutableArtifact(store, 'ws/q3-v1.md', v1, {});
  await writeImmutableArtifact(store, 'ws/q3-v2.md', v2, {});

  assert.deepEqual(objects.get('ws/q3-v1.md'), v1);
  assert.deepEqual(objects.get('ws/q3-v2.md'), v2);
  assert.equal(objects.size, 2);
});

test('the artifact carries metadata identifying its source', async () => {
  const seen: any[] = [];
  const store = {
    provider: 'gcs', bucketName: 'published',
    async putStream(_key: string, _src: Readable, options?: any) { seen.push(options); return {} as any; },
    async head() { throw new Error('not reached'); },
  } as unknown as ObjectStore;

  await writeImmutableArtifact(store, 'ws/q3-v1.md', BODY, {
    mimeType: 'text/markdown',
    customMetadata: { 'helpudoc-file-id': '412', 'helpudoc-publication-version': '1' },
  });

  assert.equal(seen[0].ifAbsent, true, 'must be a create-only write');
  assert.equal(seen[0].sha256, hashBuffer(BODY));
  assert.equal(seen[0].customMetadata['helpudoc-file-id'], '412');
});
