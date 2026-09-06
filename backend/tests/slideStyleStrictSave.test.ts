import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import createFileRouter from '../src/api/files';
import { FileService } from '../src/services/fileService';
import { ConflictError } from '../src/errors';

test('style saves require a version and pass strict concurrency to the file service', async () => {
  const calls: unknown[][] = [];
  const files = { updateFile: async (...args: unknown[]) => {
    calls.push(args);
    if (args[3] === 1) throw new ConflictError('File version mismatch');
    return { id: 12, version: 3, content: args[1] };
  } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).userContext = { userId: 'test-user' }; next(); });
  app.use('/workspaces/:workspaceId/files', createFileRouter(files as any, {} as any, {} as any));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspaces/test/files/12/content`;
    const send = (body: object) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ content: 'draft', strictVersion: true })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await send({ content: 'draft', version: 1, strictVersion: true })).status, 409);
    assert.equal((await send({ content: 'draft', version: 2, strictVersion: true })).status, 200);
    assert.deepEqual(calls[1], [12, 'draft', 'test-user', 2, { strictVersion: true }]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('updateFile forwards strictVersion to the atomic artifact commit', async () => {
  const service = Object.create(FileService.prototype) as any;
  const query = { where: () => query, whereNull: () => query, first: async () => ({ id: 12, name: 'deck.html', mimeType: 'text/html' }) };
  service.db = () => query;
  service.commitFileBuffer = async (...args: unknown[]) => args;
  const args = await service.updateFile(12, '<html>draft</html>', 'test-user', 4, { strictVersion: true });
  assert.equal(args[3], 4);
  assert.deepEqual(args[4], { strictVersion: true });
  assert.equal(args[1].toString(), '<html>draft</html>');
});
