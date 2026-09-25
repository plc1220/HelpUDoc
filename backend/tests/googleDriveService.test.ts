import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleDriveService } from '../src/services/googleDriveService';

test('published Drive upload uses a pre-generated id and requests only drive.file beyond base scopes', async (t) => {
  const requestedScopes: string[][] = [];
  const oauth = {
    getDelegatedAccessToken: async (_userId: string, scopes: string[] = []) => {
      requestedScopes.push(scopes);
      return { accessToken: 'test-token', expiresAt: 0, source: 'cached' as const };
    },
  };
  const service = new GoogleDriveService(oauth as any, {} as any);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.match(String(init?.headers && new Headers(init.headers).get('Authorization')), /Bearer test-token/);
    if (url.pathname.endsWith('/files/generateIds')) {
      return { ok: true, json: async () => ({ ids: ['generated-drive-id'] }) } as Response;
    }
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/upload/drive/v3/files');
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(new Headers(init.headers).get('X-Upload-Content-Length'), '15');
      assert.match(String(init.body), /generated-drive-id/);
      assert.match(String(init.body), /helpudocPublicationId/);
      return { ok: true, headers: new Headers({ Location: 'https://www.googleapis.com/upload/session-1' }) } as Response;
    }
    assert.equal(String(input), 'https://www.googleapis.com/upload/session-1');
    assert.equal(new Headers(init?.headers).get('Content-Range'), 'bytes 0-14/15');
    assert.equal(Buffer.from(init?.body as ArrayBuffer).toString(), 'published bytes');
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: 'generated-drive-id', webViewLink: 'https://drive.google.com/file/d/generated-drive-id' }),
    } as Response;
  }) as typeof fetch;

  assert.equal(await service.generateUploadId('user-1'), 'generated-drive-id');
  const result = await service.uploadPublishedArtifact('user-1', {
    driveFileId: 'generated-drive-id',
    name: 'release.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('published bytes'),
    publicationId: 'publication-1',
    onUploadSession: async (uri) => assert.equal(uri, 'https://www.googleapis.com/upload/session-1'),
  });
  assert.equal(result.webViewLink, 'https://drive.google.com/file/d/generated-drive-id');
  assert.deepEqual(requestedScopes, [
    ['https://www.googleapis.com/auth/drive.file'],
    ['https://www.googleapis.com/auth/drive.file'],
  ]);
});

test('Google Sheets import exports native sheets as xlsx workbooks', async (t) => {
  const service = new GoogleDriveService({} as any, {} as any);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const exported = Buffer.from('fake-xlsx-content');
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /\/drive\/v3\/files\/sheet-123\/export/);
    assert.match(
      decodeURIComponent(url),
      /mimeType=application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
    );
    return {
      ok: true,
      arrayBuffer: async () => exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength),
    } as Response;
  }) as typeof fetch;

  const payload = await (service as any).buildImportPayload('token', {
    id: 'sheet-123',
    name: 'Pipeline Tracker',
    mimeType: 'application/vnd.google-apps.spreadsheet',
  });

  assert.equal(payload.fileName, 'Pipeline Tracker.xlsx');
  assert.equal(payload.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(payload.forceLocal, undefined);
  assert.deepEqual(payload.buffer, exported);
});
