import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleDriveService } from '../src/services/googleDriveService';

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
