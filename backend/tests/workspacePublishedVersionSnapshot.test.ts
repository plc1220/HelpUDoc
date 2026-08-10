/**
 * Regression tests for issue 2 on the API side: a published version must be readable as an
 * immutable, read-only snapshot without touching the mutable Working version.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { WorkspacePublicationService } from '../src/services/workspacePublicationService.ts';

type HarnessOptions = {
  visibility?: 'team' | 'private';
  currentPublishedVersionId?: string | null;
  manifest?: unknown;
  versionId?: string;
};

function snapshotHarness(options: HarnessOptions = {}) {
  const {
    visibility = 'team',
    currentPublishedVersionId = 'version-2',
    versionId = 'version-2',
    manifest = {
      files: [
        { name: 'scope.md', mimeType: 'text/markdown', hash: 'hash-scope', size: 120 },
        { name: 'commercials.md', mimeType: 'text/markdown', hash: 'hash-commercials', size: 340 },
        { name: 'assets/logo.png', mimeType: 'image/png', hash: 'hash-logo', size: 900 },
      ],
      folders: ['assets', 'assets'],
    },
  } = options;

  const workspace = {
    id: 'workspace-shared',
    name: 'Shared workspace',
    ownerId: 'owner-user',
    visibility,
    currentPublishedVersionId,
  };
  const membershipCalls: Array<{ workspaceId: string; userId: string }> = [];
  const queriedTables: string[] = [];

  const db = ((table: string) => {
    queriedTables.push(table);
    if (table === 'workspace_published_versions') {
      return {
        where: (criteria: { id: string; teamWorkspaceId: string }) => ({
          first: async () => (criteria.id === versionId && criteria.teamWorkspaceId === workspace.id
            ? {
                id: versionId,
                teamWorkspaceId: workspace.id,
                versionNumber: 2,
                sourceContentRevision: 7,
                publisherUserId: 'owner-user',
                note: 'Board pack',
                manifest,
                createdAt: '2026-08-01T09:00:00.000Z',
              }
            : undefined),
        }),
      };
    }
    throw new Error(`Unexpected table access: ${table}`);
  }) as never;

  const service = Object.create(WorkspacePublicationService.prototype) as WorkspacePublicationService;
  Object.assign(service, {
    db,
    workspaceService: {
      ensureMembership: async (workspaceId: string, userId: string) => {
        membershipCalls.push({ workspaceId, userId });
        return { workspace };
      },
    },
  });

  return { service, membershipCalls, queriedTables };
}

// ─── getVersionSnapshot ──────────────────────────────────────────────────────

test('a published version snapshot lists manifest files without reading the Working version', async () => {
  const { service, queriedTables } = snapshotHarness();
  const snapshot = await service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user');

  assert.equal(snapshot.versionId, 'version-2');
  assert.equal(snapshot.versionNumber, 2);
  assert.equal(snapshot.note, 'Board pack');
  assert.equal(snapshot.isCurrent, true);
  assert.deepEqual(snapshot.files.map((file) => file.name), [
    'assets/logo.png',
    'commercials.md',
    'scope.md',
  ]);
  assert.deepEqual(snapshot.folders, ['assets']);
  // Snapshot reads must never touch the mutable `files` table.
  assert.ok(!queriedTables.includes('files'));
});

test('snapshot file ids are namespaced per version so the UI can detect published mode', async () => {
  const { service } = snapshotHarness();
  const snapshot = await service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user');
  for (const file of snapshot.files) {
    assert.equal(file.id, `published:version-2:${file.name}`);
    assert.equal(file.publishedVersionId, 'version-2');
    assert.equal(file.path, file.name);
    assert.equal(file.workspaceId, 'workspace-shared');
  }
});

test('a non-current published version is reported as historical', async () => {
  const { service } = snapshotHarness({ currentPublishedVersionId: 'version-3' });
  const snapshot = await service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user');
  assert.equal(snapshot.isCurrent, false);
});

test('a withdrawn publication still exposes its immutable history', async () => {
  const { service } = snapshotHarness({ currentPublishedVersionId: null });
  const snapshot = await service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user');
  assert.equal(snapshot.isCurrent, false);
  assert.equal(snapshot.files.length, 3);
});

test('legacy array manifests are still readable', async () => {
  const { service } = snapshotHarness({
    manifest: [{ name: 'scope.md', mimeType: 'text/markdown', hash: 'hash-scope', size: 120 }],
  });
  const snapshot = await service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user');
  assert.deepEqual(snapshot.files.map((file) => file.name), ['scope.md']);
  assert.deepEqual(snapshot.folders, []);
});

test('snapshot reads require membership of the Shared workspace', async () => {
  const { service, membershipCalls } = snapshotHarness();
  await service.getVersionSnapshot('workspace-shared', 'version-2', 'viewer-user');
  assert.deepEqual(membershipCalls, [{ workspaceId: 'workspace-shared', userId: 'viewer-user' }]);
});

test('private workspaces have no published versions to view', async () => {
  const { service } = snapshotHarness({ visibility: 'private' });
  await assert.rejects(
    () => service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user'),
    /only available for Shared workspaces/,
  );
});

test('an unknown version id is rejected', async () => {
  const { service } = snapshotHarness();
  await assert.rejects(
    () => service.getVersionSnapshot('workspace-shared', 'version-missing', 'owner-user'),
    /Published version not found/,
  );
});

test('manifest paths that escape the snapshot directory are rejected', async () => {
  const { service } = snapshotHarness({
    manifest: { files: [{ name: '../secrets.env', mimeType: null, hash: 'h', size: 1 }], folders: [] },
  });
  await assert.rejects(
    () => service.getVersionSnapshot('workspace-shared', 'version-2', 'owner-user'),
    /Invalid workspace content path/,
  );
});

// ─── readVersionFile ─────────────────────────────────────────────────────────

test('reading a file absent from the manifest fails before any disk access', async () => {
  const { service } = snapshotHarness();
  await assert.rejects(
    () => service.readVersionFile('workspace-shared', 'version-2', 'not-in-snapshot.md', 'owner-user'),
    /File not found in this published version/,
  );
});

test('published file reads are refused for private workspaces', async () => {
  const { service } = snapshotHarness({ visibility: 'private' });
  await assert.rejects(
    () => service.readVersionFile('workspace-shared', 'version-2', 'scope.md', 'owner-user'),
    /only available for Shared workspaces/,
  );
});

test('published file reads reject traversal attempts in the requested path', async () => {
  const { service } = snapshotHarness();
  await assert.rejects(
    () => service.readVersionFile('workspace-shared', 'version-2', '../../etc/passwd', 'owner-user'),
    /Invalid workspace content path/,
  );
});

test('published file reads use immutable object references when present', async () => {
  const manifest = {
    files: [{
      name: 'scope.md',
      mimeType: 'text/markdown',
      hash: 'hash-scope',
      size: 16,
      fileVersionId: 'file-version-7',
      objectKey: 'workspace/.system/file-versions/file-version-7',
      objectProvider: 's3',
      providerVersion: 'provider-version-1',
    }],
    folders: [],
  };
  const { service } = snapshotHarness({ manifest });
  const reads: Array<{ key: string; providerVersion?: string }> = [];
  Object.assign(service, {
    objectStore: {
      provider: 's3',
      getStream: async (key: string, options: { providerVersion?: string }) => {
        reads.push({ key, providerVersion: options.providerVersion });
        return { stream: Readable.from(Buffer.from('immutable scope')), metadata: {} };
      },
    },
  });

  const file = await service.readVersionFile(
    'workspace-shared',
    'version-2',
    'scope.md',
    'owner-user',
  );
  assert.equal(file.content, 'immutable scope');
  assert.deepEqual(reads, [{
    key: 'workspace/.system/file-versions/file-version-7',
    providerVersion: 'provider-version-1',
  }]);
});
