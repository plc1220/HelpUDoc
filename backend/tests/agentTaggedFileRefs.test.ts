import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveTaggedFileContext,
  supportsCurrentTurnMultimodalMimeType,
} from '../src/api/agent/runs';

const files = [
  {
    id: 11,
    workspaceId: 'workspace-1',
    name: 'reports/brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    version: 3,
  },
  {
    id: 12,
    workspaceId: 'workspace-1',
    name: 'reports/source.pdf',
    mimeType: 'application/pdf',
    version: 7,
  },
  {
    id: 13,
    workspaceId: 'workspace-1',
    name: 'slides/deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    version: 2,
  },
];

const makeFileService = () => {
  const mirrored: number[] = [];
  const historical: Array<{ fileId: number; version: number }> = [];
  return {
    mirrored,
    historical,
    service: {
      getFiles: async (workspaceId: string, userId: string) => {
        assert.equal(workspaceId, 'workspace-1');
        assert.equal(userId, 'user-1');
        return files;
      },
      ensureLocalMirror: async (file: { id: number }) => {
        mirrored.push(file.id);
        return `/workspaces/workspace-1/${files.find((candidate) => candidate.id === file.id)?.name}`;
      },
      ensureLocalMirrorForVersion: async (file: { id: number }, version: number) => {
        mirrored.push(file.id);
        historical.push({ fileId: file.id, version });
        return `/workspaces/workspace-1/.system/tagged-versions/${file.id}/v${version}/file`;
      },
    },
  };
};

test('stable tagged refs resolve server records, materialize files, and only attach PDF/images natively', async () => {
  const { service, mirrored } = makeFileService();
  const result = await resolveTaggedFileContext(
    service as any,
    'Compare these files',
    'workspace-1',
    'user-1',
    undefined,
    [
      { fileId: 11, version: 3, name: 'client-name-is-not-trusted.docx' },
      { fileId: 12, version: 7 },
      { fileId: 13, version: 2 },
    ],
  );

  assert.deepEqual(mirrored, [11, 12, 13]);
  assert.deepEqual(result.currentTurnFileIds, [12]);
  assert.deepEqual(result.taggedFileRefs.map((ref) => ({
    fileId: ref.fileId,
    version: ref.version,
    name: ref.name,
    path: ref.path,
  })), [
    { fileId: 11, version: 3, name: 'reports/brief.docx', path: '/reports/brief.docx' },
    { fileId: 12, version: 7, name: 'reports/source.pdf', path: '/reports/source.pdf' },
    { fileId: 13, version: 2, name: 'slides/deck.pptx', path: '/slides/deck.pptx' },
  ]);
  assert.match(result.prompt, /Tagged files \(preferred for retrieval; backend-authorized and materialized\):/);
  assert.match(result.prompt, /- \/reports\/brief\.docx/);
  assert.match(result.prompt, /Trusted tagged file references/);
  assert.doesNotMatch(result.prompt, /client-name-is-not-trusted/);
});

test('legacy tagged paths remain supported and are materialized', async () => {
  const { service, mirrored } = makeFileService();
  const result = await resolveTaggedFileContext(
    service as any,
    'Inspect it',
    'workspace-1',
    'user-1',
    ['brief.docx'],
  );

  assert.deepEqual(mirrored, [11]);
  assert.equal(result.taggedFileRefs[0]?.fileId, 11);
  assert.deepEqual(result.currentTurnFileIds, []);
});

test('a historical requested version is materialized without silently reading newer content', async () => {
  const { service, mirrored, historical } = makeFileService();
  const result = await resolveTaggedFileContext(
    service as any,
    'Inspect it',
    'workspace-1',
    'user-1',
    undefined,
    [{ fileId: 12, version: 6 }],
  );
  assert.deepEqual(mirrored, [12]);
  assert.deepEqual(historical, [{ fileId: 12, version: 6 }]);
  assert.equal(result.taggedFileRefs[0]?.version, 6);
  assert.equal(result.taggedFileRefs[0]?.path, '/.system/tagged-versions/12/v6/source.pdf');
  assert.deepEqual(result.currentTurnFileRefs, [{ fileId: 12, version: 6 }]);
});

test('file ids outside the authorized workspace-visible set are rejected', async () => {
  const { service } = makeFileService();
  await assert.rejects(
    resolveTaggedFileContext(
      service as any,
      'Inspect it',
      'workspace-1',
      'user-1',
      undefined,
      [{ fileId: 999 }],
    ),
    (error: any) => error?.statusCode === 404,
  );
});

test('native current-turn MIME support excludes Office binaries', () => {
  assert.equal(supportsCurrentTurnMultimodalMimeType('application/pdf'), true);
  assert.equal(supportsCurrentTurnMultimodalMimeType('image/png'), true);
  assert.equal(
    supportsCurrentTurnMultimodalMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    false,
  );
});
