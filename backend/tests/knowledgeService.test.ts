import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeService, splitMarkdownSections } from '../src/services/knowledgeService';
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
  const filters: Array<[string, unknown]> = [];
  const service = Object.create(KnowledgeService.prototype) as any;
  service.workspaceService = {
    ensureMembership: async () => undefined,
  };
  service.fileService = {};
  service.baseQuery = () => ({
    where: (column: string, value: unknown) => {
      filters.push([column, value]);
      return {
      andWhere: (nextColumn: string, nextValue: unknown) => {
        filters.push([nextColumn, nextValue]);
        return {
        orderBy: async () => rows,
      };
      },
    };
    },
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
  assert.deepEqual(filters, [
    ['knowledge_sources.workspaceId', 'workspace-1'],
    ['knowledge_sources.isGlobal', false],
  ]);
});

test('OKF bundle paths are normalized and traversal-safe', () => {
  const service = Object.create(KnowledgeService.prototype) as any;

  assert.equal(service.normalizeBundleRelativePath('concepts/page-12.md'), 'concepts/page-12.md');
  assert.equal(service.normalizeBundleRelativePath('manifest.json'), 'manifest.json');
  assert.throws(
    () => service.normalizeBundleRelativePath('../source.md'),
    (error: unknown) => error instanceof ConflictError && error.message === 'Invalid OKF bundle path',
  );
  assert.throws(
    () => service.normalizeBundleRelativePath('concepts/page-12.pdf'),
    (error: unknown) => error instanceof ConflictError && error.message === 'OKF bundle files must be Markdown',
  );
});

test('section extraction does not silently truncate large documents', () => {
  const markdown = Array.from({ length: 75 }, (_, index) => `## Section ${index + 1}\n\nBody ${index + 1}`).join('\n\n');

  const sections = splitMarkdownSections(markdown);

  assert.equal(sections.length, 75);
  assert.equal(sections[74].title, 'Section 75');
});

test('OKF bundle files receive stable inspector kinds', () => {
  const service = Object.create(KnowledgeService.prototype) as any;

  assert.equal(service.bundleFileKind('index.md'), 'index');
  assert.equal(service.bundleFileKind('source.md'), 'source');
  assert.equal(service.bundleFileKind('log.md'), 'log');
  assert.equal(service.bundleFileKind('concepts/returns.md'), 'concept');
  assert.equal(service.bundleFileKind('notes.md'), 'other');
});

test('direct knowledge uploads reserve object storage without buffering file bytes', async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const service = Object.create(KnowledgeService.prototype) as any;
  service.fileService = {
    createDirectUploadUrl: async (
      workspaceId: string,
      uploadId: string,
      fileName: string,
      mimeType: string,
    ) => ({
      objectKey: `${workspaceId}/.system/uploads/${uploadId}/${fileName}`,
      uploadUrl: `https://uploads.example.test/helpudoc/${uploadId}`,
      requestedFileName: fileName,
      mimeType,
    }),
  };
  service.ensureKnowledgeStorageWorkspace = async () => 'workspace-1';
  service.cleanupExpiredUploadSessions = async () => 0;
  service.db = (tableName: string) => {
    assert.equal(tableName, 'knowledge_upload_sessions');
    return {
      insert: async (row: Record<string, unknown>) => { inserted.push(row); },
    };
  };

  const session = await service.createGlobalUploadSession('user-1', {
    fileName: 'The History of Bo-Peep.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 135_098_025,
    title: 'The History of Bo-Peep',
    type: 'text',
    metadata: { source: 'upload', uploadMode: 'direct' },
  });

  assert.equal(session.status, 'pending');
  assert.equal(session.sizeBytes, 135_098_025);
  assert.equal(session.headers['Content-Type'], 'application/pdf');
  assert.match(session.uploadUrl, /^https:\/\/uploads\.example\.test\//);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].sizeBytes, 135_098_025);
  assert.equal('buffer' in inserted[0], false);
});

test('direct knowledge upload validation rejects unsupported and oversized files', async () => {
  const service = Object.create(KnowledgeService.prototype) as any;
  service.fileService = {};

  await assert.rejects(
    service.createGlobalUploadSession('user-1', {
      fileName: 'malware.exe',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      title: 'Unsupported',
      type: 'text',
    }),
    /Unsupported knowledge upload type/,
  );
  await assert.rejects(
    service.createGlobalUploadSession('user-1', {
      fileName: 'too-large.pdf',
      mimeType: 'application/pdf',
      sizeBytes: (1024 ** 3) + 1,
      title: 'Oversized',
      type: 'text',
    }),
    /Knowledge uploads must be between/,
  );
});
