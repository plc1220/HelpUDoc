import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';
import express from 'express';
import { AxiosError } from 'axios';
import createFileRouter from '../src/api/files';
import { AccessDeniedError, ConflictError, HttpError } from '../src/errors';
import { FileService } from '../src/services/fileService';
import { OfficeDocumentService } from '../src/services/officeDocumentService';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const source = Buffer.from('PK original document');
const updated = Buffer.from('PK edited document');
const edit = { paragraphId: 'p:0', start: 0, end: 4, quote: 'Text', action: 'bold', value: true };
const input = { version: 3, revision: hash(source), edit };
const httpStatus = (expected: number) => (error: any) => error instanceof HttpError && error.statusCode === expected;

function fixture() {
  const current = { id: 12, name: 'folder/report.docx', workspaceId: 'workspace', version: 3 };
  let canEdit = true;
  let allowed = true;
  const calls: { preview: any[]; edit: any[]; commit: any[]; restore: any[]; download: any[] } = {
    preview: [], edit: [], commit: [], restore: [], download: [],
  };
  const versions: any[] = [
    { id: 'version-3', version: 3, baseVersion: 2, createdBy: 'user', operationId: 'office-quick-edit:server-id' },
    { id: 'version-2', version: 2, createdBy: 'other-user' },
  ];
  const files: any = {
    getFileRecord: async (_id: number, _user: string, options: any) => {
      if (!allowed || options.requireEdit && !canEdit) throw new AccessDeniedError();
      return { ...current };
    },
    getFileDownloadStream: async (...args: any[]) => {
      calls.download.push(args);
      return { stream: Readable.from([source]), sizeBytes: source.length };
    },
    commitFileBuffer: async (...args: any[]) => {
      calls.commit.push(args);
      if (args[4]?.strictVersion && current.version !== args[3]) throw new ConflictError('File version mismatch');
      current.version += 1;
      return { ...current };
    },
    getFileVersions: async () => versions,
    restoreFileVersion: async (...args: any[]) => {
      calls.restore.push(args);
      if (current.version !== args[3]) throw new ConflictError('File version mismatch');
      current.version += 1;
      return { ...current };
    },
  };
  const workspaces: any = {
    ensureMembership: async () => {
      if (!allowed) throw new AccessDeniedError();
      return { membership: { canEdit } };
    },
  };
  const agent: any = {
    preview: async (...args: any[]) => {
      calls.preview.push(args);
      return { pdf: Buffer.from('%PDF-1.7 example').toString('base64'), revision: hash(source), document: { paragraphs: [], styles: [] } };
    },
    edit: async (...args: any[]) => {
      calls.edit.push(args);
      return { content: updated.toString('base64'), revision: hash(updated) };
    },
  };
  const service = new OfficeDocumentService(files, workspaces, agent);
  return { service, files, workspaces, agent, calls, current, versions,
    setCanEdit: (value: boolean) => { canEdit = value; },
    setAllowed: (value: boolean) => { allowed = value; },
  };
}

test('Office previews read an immutable version and send a workspace-scoped signed token', async () => {
  const f = fixture();
  const result = await f.service.preview('workspace', 12, 'user');
  assert.equal(result.version, 3);
  assert.equal(result.revision, hash(source));
  assert.equal(result.canEdit, true);
  assert.deepEqual(f.calls.download, [[12, 'user', 3]]);
  assert.deepEqual(f.calls.preview[0][0], { workspaceId: 'workspace', filename: 'report.docx', content: source.toString('base64') });
  const token = f.calls.preview[0][1].authToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.workspaceId, 'workspace');
  assert.equal(claims.userId, 'user');
  f.setCanEdit(false);
  assert.equal((await f.service.preview('workspace', 12, 'user')).canEdit, false);
  await assert.rejects(f.service.quickEdit('workspace', 12, 'user', input), httpStatus(403));
  assert.equal(f.calls.edit.length, 0);
});

test('Office routes reject unrelated workspace IDs and inaccessible files before reading bytes', async () => {
  const f = fixture();
  await assert.rejects(f.service.preview('unrelated', 12, 'user'), httpStatus(404));
  await assert.rejects(f.service.quickEdit('unrelated', 12, 'user', input), httpStatus(404));
  await assert.rejects(f.service.undo('unrelated', 12, 'user', { version: 3, restoreVersion: 2 }), httpStatus(404));
  assert.equal(f.calls.download.length, 0);
  f.setAllowed(false);
  await assert.rejects(f.service.preview('workspace', 12, 'user'), httpStatus(403));
  await assert.rejects(f.service.previewBytes('workspace', 'user', { filename: 'report.docx', content: source.toString('base64') }), httpStatus(403));
  assert.equal(f.calls.preview.length, 0);
});

test('byte previews remain read-only and reject invalid content', async () => {
  const f = fixture();
  const result = await f.service.previewBytes('workspace', 'user', { filename: 'published/report.docx', content: source.toString('base64') });
  assert.equal(result.canEdit, false);
  assert.equal(result.version, null);
  assert.equal(f.calls.download.length, 0);
  await assert.rejects(f.service.previewBytes('workspace', 'user', { filename: 'report.docx', content: 'not base64' }), httpStatus(400));
  await assert.rejects(f.service.previewBytes('workspace', 'user', { filename: 'sheet.xlsx', content: source.toString('base64') }), httpStatus(422));
});

test('quick edits save only exact source versions and return updated document bytes', async () => {
  const f = fixture();
  const result = await f.service.quickEdit('workspace', 12, 'user', input);
  assert.equal(result.previousVersion, 3);
  assert.equal(result.file.version, 4);
  assert.equal(result.file.content, updated.toString('base64'));
  assert.equal(f.calls.commit[0][3], 3);
  assert.equal(f.calls.commit[0][4].strictVersion, true);
  assert.match(f.calls.commit[0][4].operationId, /^office-quick-edit:/);
  assert.deepEqual(f.calls.commit[0][1], updated);
  assert.deepEqual(f.calls.edit[0][0].edit, edit);
});

test('stale source revisions, concurrent edits, and invalid renderer responses never overwrite changes', async () => {
  const f = fixture();
  await assert.rejects(f.service.quickEdit('workspace', 12, 'user', { ...input, version: 2 }), httpStatus(409));
  await assert.rejects(f.service.quickEdit('workspace', 12, 'user', { ...input, revision: 'a'.repeat(64) }), httpStatus(409));
  assert.equal(f.calls.edit.length, 0);
  const originalEdit = f.agent.edit;
  f.agent.edit = async (...args: any[]) => { f.current.version = 4; return originalEdit(...args); };
  await assert.rejects(f.service.quickEdit('workspace', 12, 'user', input), httpStatus(409));
  assert.equal(f.current.version, 4);
  f.current.version = 3;
  f.agent.edit = async () => ({ content: updated.toString('base64'), revision: 'a'.repeat(64) });
  await assert.rejects(f.service.quickEdit('workspace', 12, 'user', input), httpStatus(502));
  assert.equal(f.calls.commit.length, 1);
});

test('undo restores only the current user’s latest quick edit, with an atomic expected version', async () => {
  const f = fixture();
  const result = await f.service.undo('workspace', 12, 'user', { version: 3, restoreVersion: 2 });
  assert.equal(result.file.version, 4);
  assert.equal(result.file.content, source.toString('base64'));
  assert.deepEqual(f.calls.restore, [[12, 'version-2', 'user', 3]]);
  const other = fixture();
  other.versions[0].createdBy = 'other-user';
  await assert.rejects(other.service.undo('workspace', 12, 'user', { version: 3, restoreVersion: 2 }), httpStatus(409));
  other.versions[0].createdBy = 'user';
  other.versions[0].operationId = 'agent-run:another-edit';
  await assert.rejects(other.service.undo('workspace', 12, 'user', { version: 3, restoreVersion: 2 }), httpStatus(409));
  assert.equal(other.calls.restore.length, 0);
  const race = fixture();
  const originalRead = race.files.getFileDownloadStream;
  race.files.getFileDownloadStream = async (...args: any[]) => { race.current.version = 4; return originalRead(...args); };
  await assert.rejects(race.service.undo('workspace', 12, 'user', { version: 3, restoreVersion: 2 }), httpStatus(409));
});

test('Office previews enforce input bounds and map converter availability errors', async () => {
  const f = fixture();
  f.files.getFileDownloadStream = async () => ({ stream: Readable.from([source]), sizeBytes: 26 * 1024 * 1024 });
  await assert.rejects(f.service.preview('workspace', 12, 'user'), httpStatus(413));
  assert.equal(f.calls.preview.length, 0);
  const unavailable = fixture();
  unavailable.agent.preview = async () => { throw new AxiosError('Unavailable', undefined, undefined, undefined, { status: 503, data: { detail: 'Office converter is not installed' } } as any); };
  await assert.rejects(unavailable.service.preview('workspace', 12, 'user'), httpStatus(503));
});

test('Office HTTP endpoints validate IDs, payloads, authentication, and return source content', async () => {
  const f = fixture();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (!req.headers['x-no-user']) (req as any).userContext = { userId: 'user' }; next(); });
  app.use('/workspaces/:workspaceId/files', createFileRouter(f.files, f.workspaces, {} as any, f.service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspaces/workspace/files`;
    const post = (route: string, body: object) => fetch(`${root}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${root}/12/office-preview`, { headers: { 'x-no-user': '1' } })).status, 401);
    assert.equal((await fetch(`${root}/12junk/office-preview`)).status, 400);
    assert.equal((await post('/12/quick-edit', { ...input, edit: { ...edit, value: 'yes' } })).status, 400);
    assert.equal((await post('/12/quick-edit', { revision: input.revision, edit })).status, 400);
    assert.equal((await post('/office-preview', { filename: 'report.docx', content: source.toString('base64') })).status, 200);
    const preview = await fetch(`${root}/12/office-preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    const saved = await post('/12/quick-edit', input);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).file.content, updated.toString('base64'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('strict commits reject changed team files while holding the database row lock', async () => {
  const service = Object.create(FileService.prototype) as any;
  const initial = { id: 12, workspaceId: 'workspace', name: 'report.docx', version: 3 };
  const query = (value: any) => {
    const builder: any = { where: () => builder, whereNull: () => builder, forUpdate: () => builder, first: async () => value };
    return builder;
  };
  service.db = (table: string) => query(table === 'files' ? initial : null);
  service.db.transaction = async (fn: any) => fn(() => query({ ...initial, version: 4 }));
  service.workspaceService = { ensureMembership: async () => ({ workspace: { visibility: 'team', editingPolicy: 'direct' } }) };
  service.ensureCanonicalVersion = async () => ({});
  service.uploadImmutableObject = async () => ({ objectKey: 'immutable', metadata: {}, sha256: hash(updated) });
  const deleted: string[] = [];
  service.objectStore = { delete: async (key: string) => { deleted.push(key); } };
  await assert.rejects(service.commitFileBuffer(12, updated, 'user', 3, { strictVersion: true }), httpStatus(409));
  assert.deepEqual(deleted, ['immutable']);
});
