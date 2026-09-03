import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleCloudStorageService } from '../src/services/googleCloudStorageService';

const BUCKET = {
  id: '11111111-1111-1111-1111-111111111111',
  bucketName: 'analytics-raw',
  pathPrefix: '',
  displayName: 'Analytics raw',
  description: null,
  defaultAccess: 'allow' as const,
  isArchived: false,
  createdByUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  teamGrants: [],
};

function bucketRegistry(overrides: Partial<typeof BUCKET> = {}) {
  const bucket = { ...BUCKET, ...overrides };
  return {
    listAccessibleBuckets: async () => [bucket],
    requireAccessibleBucket: async () => bucket,
  } as any;
}

/** Routes each request URL to a canned response, and records what was asked. */
function stubFetch(t: any, handlers: Array<{ match: RegExp; json?: unknown; body?: Buffer }>) {
  const originalFetch = global.fetch;
  const calls: string[] = [];
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const handler = handlers.find((entry) => entry.match.test(url));
    if (!handler) {
      throw new Error(`Unexpected request: ${url}`);
    }
    if (handler.body) {
      const buffer = handler.body;
      return {
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      } as Response;
    }
    return { ok: true, json: async () => handler.json } as Response;
  }) as typeof fetch;

  return calls;
}

test('a listing maps prefixes to folders and drops console folder placeholders', async (t) => {
  stubFetch(t, [{
    match: /\/storage\/v1\/b\/analytics-raw\/o\?/,
    json: {
      prefixes: ['2026/', '2025/'],
      items: [
        // The zero-byte placeholder the Cloud console writes for a "folder".
        { name: '2026/', size: '0', contentType: 'application/x-directory' },
        { name: 'q3-report.pdf', size: '2200000', contentType: 'application/pdf', updated: '2026-08-01T10:00:00Z', generation: '17550000000001' },
        { name: 'events.csv', size: '4096', contentType: 'text/csv', updated: '2026-08-02T10:00:00Z', generation: '17550000000002' },
      ],
      nextPageToken: 'page-2',
    },
  }]);

  const service = new GoogleCloudStorageService(
    { getDelegatedAccessToken: async () => ({ accessToken: 'token' }) } as any,
    {} as any,
    bucketRegistry(),
  );

  const result = await service.listObjects('user-1', { bucketId: BUCKET.id });

  assert.deepEqual(
    result.entries.map((entry) => [entry.kind, entry.name, entry.iconHint]),
    [
      ['prefix', '2026', 'file'],
      ['prefix', '2025', 'file'],
      ['object', 'q3-report.pdf', 'pdf'],
      ['object', 'events.csv', 'sheets'],
    ],
  );
  assert.equal(result.nextPageToken, 'page-2');
  assert.equal(result.prefix, '');
});

test('the delegated token is demanded with the Cloud Storage scope', async (t) => {
  stubFetch(t, [{ match: /\/o\?/, json: { items: [] } }]);
  const seen: unknown[] = [];

  const service = new GoogleCloudStorageService(
    {
      getDelegatedAccessToken: async (_userId: string, options: unknown) => {
        seen.push(options);
        return { accessToken: 'token' };
      },
    } as any,
    {} as any,
    bucketRegistry(),
  );

  await service.listObjects('user-1', { bucketId: BUCKET.id });

  assert.deepEqual(seen, [{ requireScopes: ['https://www.googleapis.com/auth/devstorage.read_only'] }]);
});

test('an unchanged object is reused without downloading it again', async (t) => {
  const existingFile = { id: 7, name: 'q3-report.pdf' };
  const calls = stubFetch(t, [{
    match: /\/o\/q3-report\.pdf\?/,
    json: { name: 'q3-report.pdf', size: '2200000', contentType: 'application/pdf', generation: '17550000000001' },
  }]);

  let createCalls = 0;
  const service = new GoogleCloudStorageService(
    { getDelegatedAccessToken: async () => ({ accessToken: 'token' }) } as any,
    {
      findImportedExternalFile: async (_w: string, _u: string, params: any) => {
        assert.equal(params.sourceProvider, 'gcs');
        assert.equal(params.sourceExternalId, 'analytics-raw/q3-report.pdf');
        assert.equal(params.sourceVersionFingerprint, '17550000000001');
        return existingFile;
      },
      createFile: async () => { createCalls += 1; return {}; },
      hasFileName: async () => false,
    } as any,
    bucketRegistry(),
  );

  const imported = await service.importObjects('ws-1', 'user-1', BUCKET.id, ['q3-report.pdf']);

  assert.deepEqual(imported, [existingFile]);
  assert.equal(createCalls, 0);
  // Metadata only. The generation already matched, so no `alt=media` transfer.
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((url) => url.includes('alt=media')));
});

test('an object above the size limit is refused before any bytes move', async (t) => {
  const previous = process.env.GCS_IMPORT_MAX_BYTES;
  process.env.GCS_IMPORT_MAX_BYTES = String(1024 * 1024);
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GCS_IMPORT_MAX_BYTES;
    } else {
      process.env.GCS_IMPORT_MAX_BYTES = previous;
    }
  });

  const calls = stubFetch(t, [{
    match: /\/o\/huge\.bin\?/,
    json: { name: 'huge.bin', size: String(50 * 1024 * 1024), contentType: 'application/octet-stream', generation: '1' },
  }]);

  const service = new GoogleCloudStorageService(
    { getDelegatedAccessToken: async () => ({ accessToken: 'token' }) } as any,
    { findImportedExternalFile: async () => null, hasFileName: async () => false } as any,
    bucketRegistry(),
  );

  await assert.rejects(
    () => service.importObjects('ws-1', 'user-1', BUCKET.id, ['huge.bin']),
    (error: any) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /above the 1 MB import limit/);
      return true;
    },
  );
  assert.ok(!calls.some((url) => url.includes('alt=media')));
});

test('a failure part-way through a batch rolls back the files already created', async (t) => {
  stubFetch(t, [
    { match: /\/o\/first\.txt\?fields/, json: { name: 'first.txt', size: '10', contentType: 'text/plain', generation: '1' } },
    { match: /\/o\/second\.txt\?fields/, json: { name: 'second.txt', size: '10', contentType: 'text/plain', generation: '2' } },
    { match: /\/o\/first\.txt\?alt=media/, body: Buffer.from('first') },
    { match: /\/o\/second\.txt\?alt=media/, body: Buffer.from('second') },
  ]);

  const deleted: number[] = [];
  const service = new GoogleCloudStorageService(
    { getDelegatedAccessToken: async () => ({ accessToken: 'token' }) } as any,
    {
      findImportedExternalFile: async () => null,
      hasFileName: async () => false,
      createFile: async (_w: string, name: string) => {
        if (name === 'second.txt') {
          throw new Error('disk full');
        }
        return { id: 41, name };
      },
      deleteFile: async (id: number) => { deleted.push(id); },
    } as any,
    bucketRegistry(),
  );

  await assert.rejects(
    () => service.importObjects('ws-1', 'user-1', BUCKET.id, ['first.txt', 'second.txt']),
    /disk full/,
  );
  assert.deepEqual(deleted, [41]);
});

test('a registration prefix bounds both browsing and import', async (t) => {
  stubFetch(t, [{ match: /\/o\?/, json: { items: [], prefixes: [] } }]);

  const service = new GoogleCloudStorageService(
    { getDelegatedAccessToken: async () => ({ accessToken: 'token' }) } as any,
    { findImportedExternalFile: async () => null, hasFileName: async () => false } as any,
    bucketRegistry({ pathPrefix: 'exports/' }),
  );

  // Inside the registration: allowed, and the default listing starts there.
  const result = await service.listObjects('user-1', { bucketId: BUCKET.id });
  assert.equal(result.prefix, 'exports/');
  await service.listObjects('user-1', { bucketId: BUCKET.id, prefix: 'exports/2026' });

  await assert.rejects(
    () => service.listObjects('user-1', { bucketId: BUCKET.id, prefix: 'secrets/' }),
    (error: any) => {
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  await assert.rejects(
    () => service.importObjects('ws-1', 'user-1', BUCKET.id, ['secrets/keys.json']),
    (error: any) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /outside this bucket registration/);
      return true;
    },
  );
});
