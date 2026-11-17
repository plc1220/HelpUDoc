import assert from 'node:assert/strict';
import test from 'node:test';
import { type S3Client } from '@aws-sdk/client-s3';
import { S3Service } from '../src/services/s3Service';

function store() {
  return new S3Service({
    config: {
      bucketName: 'presign-contract', endpoint: 'http://internal.invalid',
      publicEndpoint: 'http://public.invalid', forcePathStyle: true,
      hasCustomEndpoint: true, region: 'us-east-1',
      accessKeyId: 'test-key', secretAccessKey: 'test-secret',
    },
    client: { send: async () => ({}) } as unknown as S3Client,
  });
}

test('presigned upload signs the SHA-256 metadata header returned to clients', async () => {
  const digest = 'a'.repeat(64);
  const signed = await store().signUpload('artifact', {
    mimeType: 'text/plain', expiresInSeconds: 60, sha256: digest, ifAbsent: true,
  });
  const query = new URL(signed.url).searchParams;
  const signedHeaders = query.get('X-Amz-SignedHeaders')!.split(';');
  assert.ok(signedHeaders.includes('x-amz-meta-helpudoc-sha256'));
  assert.ok(signedHeaders.includes('if-none-match'));
  assert.equal(signed.headers['x-amz-meta-helpudoc-sha256'], digest);
  assert.equal(signed.headers['if-none-match'], '*');
  assert.equal(query.has('x-amz-meta-helpudoc-sha256'), false);
});

test('presigned upload without a digest does not require a metadata header', async () => {
  const signed = await store().signUpload('artifact', {
    mimeType: 'text/plain', expiresInSeconds: 60,
  });
  assert.equal(signed.headers['x-amz-meta-helpudoc-sha256'], undefined);
  assert.equal(new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')!.includes('x-amz-meta-'), false);
});
