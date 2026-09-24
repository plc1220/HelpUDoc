import assert from 'node:assert/strict';
import test from 'node:test';
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { ObjectStoreError } from '../src/services/objectStore';
import { S3Service } from '../src/services/s3Service';

function makeStore(send: (command: ListObjectsV2Command) => Promise<unknown>): S3Service {
  return new S3Service({
    config: {
      bucketName: 'report-bucket',
      endpoint: 'http://internal.invalid',
      publicEndpoint: 'http://public.invalid',
      forcePathStyle: true,
      hasCustomEndpoint: true,
      region: 'test-region',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    },
    client: { send } as unknown as S3Client,
  });
}

test('prefix stats aggregate every page using only read-only listing commands', async () => {
  const calls: ListObjectsV2Command[] = [];
  const store = makeStore(async (command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    calls.push(command);
    assert.equal(command.input.Bucket, 'report-bucket');
    assert.equal(command.input.Prefix, 'workspace/');
    if (calls.length === 1) {
      assert.equal(command.input.ContinuationToken, undefined);
      return {
        Contents: [{ Key: 'workspace/a', Size: 12 }, { Key: 'workspace/empty', Size: 0 }],
        IsTruncated: true,
        NextContinuationToken: 'next-page',
      };
    }
    assert.equal(command.input.ContinuationToken, 'next-page');
    return { Contents: [{ Key: 'workspace/b', Size: 30 }], IsTruncated: false };
  });
  assert.deepEqual(await store.getPrefixStats('workspace/'), { objectCount: 3, totalBytes: 42 });
  assert.equal(calls.length, 2);
});

test('prefix stats return zeros for an empty prefix', async () => {
  const store = makeStore(async () => ({ IsTruncated: false }));
  assert.deepEqual(await store.getPrefixStats('empty/'), { objectCount: 0, totalBytes: 0 });
});

test('prefix stats reject failed later pages instead of returning partial totals', async () => {
  const cause = Object.assign(new Error('denied'), { name: 'AccessDenied' });
  const store = makeStore(async (command) => {
    if (!command.input.ContinuationToken) {
      return { Contents: [{ Key: 'workspace/a', Size: 12 }], IsTruncated: true, NextContinuationToken: 'next' };
    }
    throw cause;
  });
  await assert.rejects(store.getPrefixStats('workspace/'), (error: unknown) => (
    error instanceof ObjectStoreError && error.code === 'FORBIDDEN'
  ));
});
