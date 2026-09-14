import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { FileService } from '../src/services/fileService';

/**
 * Re-uploading a file a workspace already holds used to be stored again under
 * "name (2).ext". Most duplicates on record were made that way, usually when an
 * autosync pulled a file in while the member was still uploading their copy of
 * it. Identical bytes at the same path are now recognised instead of renamed.
 */

const sha256 = (payload: Buffer) => createHash('sha256').update(payload).digest('hex');

/** FileService with only the parts `findIdenticalFileAtPath` reaches. */
const serviceWith = (file: Record<string, unknown> | null, version: Record<string, unknown> | null) => {
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    workspaceService: { ensureMembership: async () => ({}) },
    db: (table: string) => {
      if (table === 'files') {
        return { where: () => ({ whereNull: () => ({ first: async () => file }) }) };
      }
      assert.equal(table, 'file_versions');
      return { where: () => ({ first: async () => version }) };
    },
  });
  return service;
};

const payload = Buffer.from('the same bytes');

test('an identical re-upload finds the file already there', async () => {
  const existing = { id: 7, name: 'report.pdf', currentVersionId: 'v1' };
  const service = serviceWith(existing, { id: 'v1', sha256: sha256(payload) });

  const found = await service.findIdenticalFileAtPath('ws-1', 'report.pdf', payload, 'user-1');

  assert.equal(found, existing, 'the caller should be handed the file that is already stored');
});

test('different bytes under the same name are not the same file', async () => {
  const service = serviceWith(
    { id: 7, name: 'report.pdf', currentVersionId: 'v1' },
    { id: 'v1', sha256: sha256(Buffer.from('an earlier draft')) },
  );

  // This is a real name clash, so the upload must fall through to being renamed.
  assert.equal(await service.findIdenticalFileAtPath('ws-1', 'report.pdf', payload, 'user-1'), null);
});

test('a path nothing occupies is not a duplicate', async () => {
  const service = serviceWith(null, null);

  assert.equal(await service.findIdenticalFileAtPath('ws-1', 'new.pdf', payload, 'user-1'), null);
});

test('a file with no recorded hash is left to the existing behaviour', async () => {
  // Nothing can be proven identical without a hash, so the upload is not
  // silently folded into a file that might hold different bytes.
  const service = serviceWith(
    { id: 7, name: 'report.pdf', currentVersionId: 'v1' },
    { id: 'v1', sha256: null },
  );

  assert.equal(await service.findIdenticalFileAtPath('ws-1', 'report.pdf', payload, 'user-1'), null);
});

test('a row with no current version is left alone', async () => {
  const service = serviceWith({ id: 7, name: 'report.pdf', currentVersionId: null }, null);

  assert.equal(await service.findIdenticalFileAtPath('ws-1', 'report.pdf', payload, 'user-1'), null);
});

test('the lookup normalizes the requested path the same way storage does', async () => {
  const existing = { id: 7, name: 'docs/report.pdf', currentVersionId: 'v1' };
  const service = serviceWith(existing, { id: 'v1', sha256: sha256(payload) });

  // A leading slash is how the agent and some clients address a workspace path.
  assert.equal(await service.findIdenticalFileAtPath('ws-1', '/docs/report.pdf', payload, 'user-1'), existing);
});
