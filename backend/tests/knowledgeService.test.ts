import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeService } from '../src/services/knowledgeService';


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
