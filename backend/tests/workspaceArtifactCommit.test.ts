import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';

import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';
import { FileService } from '../src/services/fileService';

const filesQuery = (rows: unknown[]) => {
  const builder: any = {
    where: () => builder,
    whereNull: () => builder,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => (
      Promise.resolve(rows).then(resolve, reject)
    ),
  };
  return builder;
};

test('workspace artifact commit discovers undeclared generated files from the filesystem', async () => {
  const workspaceId = `artifact-delta-${randomUUID()}`;
  const workspacePath = path.join(resolveWorkspaceRoot(), workspaceId);
  const imagePath = path.join(workspacePath, 'generated-image.png');
  const assetsPath = path.join(workspacePath, 'generated-image-assets.json');
  const internalPath = path.join(workspacePath, 'sandbox-runs', 'run-1', 'temporary.png');
  const created: Array<{ name: string; mimeType: string; payload: Buffer }> = [];
  let leaseAssertions = 0;

  await fs.mkdir(path.dirname(internalPath), { recursive: true });
  await fs.writeFile(imagePath, Buffer.from('image-bytes'));
  await fs.writeFile(assetsPath, Buffer.from('{"version":"1"}'));
  await fs.writeFile(internalPath, Buffer.from('temporary-image'));

  try {
    const service = Object.create(FileService.prototype) as FileService;
    (service as any).workspaceService = {
      ensureMembership: async () => undefined,
    };
    (service as any).db = () => filesQuery([]);
    (service as any).walkWorkspace = async () => [imagePath, assetsPath, internalPath];
    (service as any).createFile = async (
      _workspaceId: string,
      name: string,
      payload: Buffer,
      mimeType: string,
    ) => {
      created.push({ name, payload, mimeType });
      return { name };
    };

    const committed = await service.commitWorkspaceArtifacts(
      workspaceId,
      'user-1',
      'run-1',
      {
        baseline: {},
        assertLeaseOwned: async () => {
          leaseAssertions += 1;
        },
      },
    );

    assert.deepEqual(created.map((file) => ({ name: file.name, mimeType: file.mimeType })), [
      { name: 'generated-image.png', mimeType: 'image/png' },
      { name: 'generated-image-assets.json', mimeType: 'application/json' },
    ]);
    assert.deepEqual(created.map((file) => file.payload.toString()), [
      'image-bytes',
      '{"version":"1"}',
    ]);
    assert.deepEqual(committed, [
      { name: 'generated-image.png' },
      { name: 'generated-image-assets.json' },
    ]);
    assert.ok(leaseAssertions >= 4);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test('workspace artifact commit does not republish unchanged durable mirrors', async () => {
  const workspaceId = `artifact-unchanged-${randomUUID()}`;
  const workspacePath = path.join(resolveWorkspaceRoot(), workspaceId);
  const reportPath = path.join(workspacePath, 'report.md');
  const payload = Buffer.from('already durable');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const durableFile = {
    id: 41,
    workspaceId,
    name: 'report.md',
    version: 3,
  };
  let createCalls = 0;
  let updateCalls = 0;

  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(reportPath, payload);

  try {
    const service = Object.create(FileService.prototype) as FileService;
    (service as any).workspaceService = {
      ensureMembership: async () => undefined,
    };
    (service as any).db = () => filesQuery([durableFile]);
    (service as any).walkWorkspace = async () => [reportPath];
    (service as any).ensureCanonicalVersion = async () => ({ sha256 });
    (service as any).createFile = async () => {
      createCalls += 1;
    };
    (service as any).commitFileBuffer = async () => {
      updateCalls += 1;
    };

    const committed = await service.commitWorkspaceArtifacts(
      workspaceId,
      'user-1',
      'run-1',
      {
        baseline: {
          'report.md': {
            fileId: 41,
            version: 3,
            sha256,
          },
        },
      },
    );

    assert.deepEqual(committed, []);
    assert.equal(createCalls, 0);
    assert.equal(updateCalls, 0);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
