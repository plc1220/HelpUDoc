import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeService } from '../src/services/knowledgeService';
import { ConflictError } from '../src/errors';


test('list queues legacy file-backed knowledge without ingestion metadata', async () => {
  const rows = [
    {
      id: 7,
      workspaceId: 'workspace-1',
      title: 'Legacy handbook',
      type: 'text',
      fileId: 21,
      metadata: null,
    },
  ];
  const metadataUpdates: Array<Record<string, unknown>> = [];
  const scheduled: number[] = [];
  const service = Object.create(KnowledgeService.prototype) as any;
  service.workspaceService = {
    ensureMembership: async () => undefined,
  };
  service.fileService = {};
  service.resolveGlobalKnowledgeAccess = async () => null;
  service.baseQuery = () => ({
    where: () => ({
      orderBy: async () => rows,
    }),
  });
  service.updateIngestionMetadata = async (
    _workspaceId: string,
    _id: number,
    ingestion: Record<string, unknown>,
  ) => {
    metadataUpdates.push(ingestion);
  };
  service.scheduleIngestion = (_workspaceId: string, id: number) => {
    scheduled.push(id);
  };

  const result = await service.list('workspace-1', 'user-1');

  assert.equal(metadataUpdates.length, 1);
  assert.equal(metadataUpdates[0].status, 'queued');
  assert.deepEqual(scheduled, [7]);
  assert.equal(result[0].metadata.ingestion.status, 'queued');
});

test('OKF bundle paths are normalized and traversal-safe', () => {
  const service = Object.create(KnowledgeService.prototype) as any;

  assert.equal(service.normalizeBundleRelativePath('concepts/page-12.md'), 'concepts/page-12.md');
  assert.throws(
    () => service.normalizeBundleRelativePath('../source.md'),
    (error: unknown) => error instanceof ConflictError && error.message === 'Invalid OKF bundle path',
  );
  assert.throws(
    () => service.normalizeBundleRelativePath('concepts/page-12.pdf'),
    (error: unknown) => error instanceof ConflictError && error.message === 'OKF bundle files must be Markdown',
  );
});

test('OKF bundle files receive stable inspector kinds', () => {
  const service = Object.create(KnowledgeService.prototype) as any;

  assert.equal(service.bundleFileKind('index.md'), 'index');
  assert.equal(service.bundleFileKind('source.md'), 'source');
  assert.equal(service.bundleFileKind('log.md'), 'log');
  assert.equal(service.bundleFileKind('concepts/returns.md'), 'concept');
  assert.equal(service.bundleFileKind('notes.md'), 'other');
});
