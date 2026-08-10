import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError } from '../src/errors';
import { WorkspacePublicationService } from '../src/services/workspacePublicationService';

type FileSpec = Record<string, string>;

type HarnessOptions = {
  baseFiles?: FileSpec;
  privateFiles?: FileSpec;
  sharedFiles?: FileSpec;
  baseFolders?: string[];
  privateFolders?: string[];
  sharedFolders?: string[];
  baseWorkingManifest?: boolean;
  privateRevision?: number;
  basePrivateRevision?: number;
  sharedRevision?: number;
  baseSharedRevision?: number;
  hasUnpublishedChanges?: boolean;
  linkStatus?: 'active' | 'detached';
  privateStatus?: 'active' | 'archived' | 'unshared' | 'trashed';
  sharedStatus?: 'active' | 'archived' | 'unshared' | 'trashed';
  sharedVisibility?: 'team' | 'private';
  sharedExists?: boolean;
  sharedAccess?: boolean;
};

function hash(value: string): string {
  return `hash:${value}`;
}

function makeContent(files: FileSpec, folders: string[] = []) {
  return {
    files: new Map(Object.entries(files).map(([name, value]) => [name, {
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(value),
      hash: hash(value),
      size: Buffer.byteLength(value),
      fileVersionId: `version:${name}:${hash(value)}`,
      objectKey: `objects/${name}/${hash(value)}`,
      objectProvider: 's3',
      providerVersion: `provider:${hash(value)}`,
    }])),
    folders,
  };
}

function makeManifest(files: FileSpec, folders: string[] = []) {
  return {
    files: Object.entries(files).map(([name, value]) => ({
      name,
      mimeType: 'text/plain',
      hash: hash(value),
      size: Buffer.byteLength(value),
      fileVersionId: `version:${name}:${hash(value)}`,
      objectKey: `objects/${name}/${hash(value)}`,
      objectProvider: 's3',
      providerVersion: `provider:${hash(value)}`,
    })),
    folders,
  };
}

function syncHarness(options: HarnessOptions = {}) {
  const userId = 'user-1';
  const privateWorkspaceId = 'ws-private';
  const teamWorkspaceId = 'ws-team';
  const baseFiles = options.baseFiles ?? { 'notes.txt': 'base' };
  const privateFiles = options.privateFiles ?? baseFiles;
  const sharedFiles = options.sharedFiles ?? baseFiles;
  const privateRevision = options.privateRevision ?? 3;
  const sharedRevision = options.sharedRevision ?? 5;

  const privateWorkspace = {
    id: privateWorkspaceId,
    name: 'Private draft',
    slug: 'private-draft',
    ownerId: userId,
    visibility: 'private' as const,
    status: options.privateStatus ?? 'active',
    contentRevision: privateRevision,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  };
  const sharedWorkspace = options.sharedExists === false ? undefined : {
    id: teamWorkspaceId,
    name: 'Shared Working',
    slug: 'shared-working',
    ownerId: userId,
    visibility: options.sharedVisibility ?? 'team',
    status: options.sharedStatus ?? 'active',
    contentRevision: sharedRevision,
    currentPublishedVersionId: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
  };
  const link: any = {
    privateWorkspaceId,
    teamWorkspaceId,
    userId,
    basePublishedVersionId: null,
    basePrivateContentRevision: options.basePrivateRevision ?? 3,
    baseSharedContentRevision: options.baseSharedRevision ?? 5,
    baseWorkingManifest: options.baseWorkingManifest === false
      ? null
      : makeManifest(baseFiles, options.baseFolders),
    hasUnpublishedChanges: options.hasUnpublishedChanges ?? false,
    status: options.linkStatus ?? 'active',
    detachedAt: options.linkStatus === 'detached' ? '2026-08-03T00:00:00Z' : null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  };

  let replaceCalls = 0;
  let readCalls = 0;
  let replacement: any = null;
  const linkUpdates: Record<string, unknown>[] = [];

  const updateLink = async (payload: Record<string, unknown>) => {
    linkUpdates.push(payload);
    Object.assign(link, payload);
    return 1;
  };
  const query = (table: string) => {
    if (table === 'workspace_publication_links') {
      return {
        where: () => ({ first: async () => link, update: updateLink }),
      };
    }
    if (table === 'workspaces') {
      return {
        where: (predicate: { id?: string }) => ({
          first: async () => predicate.id === teamWorkspaceId ? sharedWorkspace : privateWorkspace,
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  };
  const db = query as any;
  db.fn = { now: () => 'NOW()' };

  const privateContent = makeContent(privateFiles, options.privateFolders);
  const sharedContent = makeContent(sharedFiles, options.sharedFolders);
  const fakeTx = ((table: string) => {
    if (table === 'workspace_publication_links') {
      return { where: () => ({ update: updateLink }) };
    }
    throw new Error(`Unexpected transaction table ${table}`);
  }) as any;
  fakeTx.fn = { now: () => 'NOW()' };

  const service = Object.create(WorkspacePublicationService.prototype) as any;
  Object.assign(service, {
    db,
    workspaceService: {
      ensureMembership: async (workspaceId: string) => {
        if (workspaceId === privateWorkspaceId) {
          return { workspace: privateWorkspace, membership: { role: 'owner' } };
        }
        if (options.sharedAccess === false) throw new AccessDeniedError('revoked');
        if (!sharedWorkspace) throw new Error('Shared workspace missing');
        return { workspace: sharedWorkspace, membership: { role: 'contributor' } };
      },
    },
    readWorkspaceContent: async (workspaceId: string) => {
      readCalls += 1;
      return workspaceId === privateWorkspaceId ? privateContent : sharedContent;
    },
    ensureContentObjects: async () => undefined,
    assertSharedWorkingRevision: async () => undefined,
    copyPublishedSkillPinsToWorkspace: async () => undefined,
    replaceWorkspaceContent: async (
      _workspaceId: string,
      content: any,
      _actor: string,
      _transaction?: unknown,
      afterUpdate?: (tx: unknown, revision: number) => Promise<void>,
    ) => {
      replaceCalls += 1;
      replacement = content;
      await afterUpdate?.(fakeTx, privateRevision + 1);
      return privateRevision + 1;
    },
  });

  return {
    service,
    link,
    privateWorkspaceId,
    userId,
    replaceCalls: () => replaceCalls,
    readCalls: () => readCalls,
    replacement: () => replacement,
    linkUpdates,
  };
}

test('clean private Working fast-forwards from the exact Shared Working manifest', async () => {
  const harness = syncHarness({
    sharedFiles: { 'notes.txt': 'shared-v2' },
    sharedRevision: 6,
  });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'synced');
  assert.equal(harness.replaceCalls(), 1);
  assert.equal(harness.replacement().files.get('notes.txt').hash, hash('shared-v2'));
  assert.equal(harness.link.baseSharedContentRevision, 6);
  assert.equal(harness.link.hasUnpublishedChanges, false);
  assert.equal(harness.link.baseWorkingManifest.files[0].objectKey, 'objects/notes.txt/hash:shared-v2');
});

test('divergent non-overlapping Working changes merge automatically', async () => {
  const harness = syncHarness({
    baseFiles: { 'private.txt': 'base-private', 'shared.txt': 'base-shared' },
    privateFiles: { 'private.txt': 'private-v2', 'shared.txt': 'base-shared' },
    sharedFiles: { 'private.txt': 'base-private', 'shared.txt': 'shared-v2' },
    privateRevision: 4,
    sharedRevision: 6,
  });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'synced');
  assert.deepEqual(result.conflicts, []);
  assert.equal(harness.replacement().files.get('private.txt').hash, hash('private-v2'));
  assert.equal(harness.replacement().files.get('shared.txt').hash, hash('shared-v2'));
  assert.equal(harness.link.hasUnpublishedChanges, true);
  const baseByName = new Map(harness.link.baseWorkingManifest.files.map((file: any) => [file.name, file]));
  assert.equal((baseByName.get('private.txt') as any).objectKey, 'objects/private.txt/hash:base-private');
  assert.equal((baseByName.get('shared.txt') as any).objectKey, 'objects/shared.txt/hash:shared-v2');
});

test('overlapping Working changes return review_needed without overwriting private content', async () => {
  const harness = syncHarness({
    privateFiles: { 'notes.txt': 'private-v2' },
    sharedFiles: { 'notes.txt': 'shared-v2' },
    privateRevision: 4,
    sharedRevision: 6,
  });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'review_needed');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, 'notes.txt');
  assert.equal(harness.replaceCalls(), 0);
  assert.equal(harness.link.baseSharedContentRevision, 5);
});

test('an explicit conflict resolution merges and advances the exact Working base', async () => {
  const harness = syncHarness({
    privateFiles: { 'notes.txt': 'private-v2' },
    sharedFiles: { 'notes.txt': 'shared-v2' },
    privateRevision: 4,
    sharedRevision: 6,
  });

  const result = await harness.service.sync(
    harness.privateWorkspaceId,
    harness.userId,
    { 'notes.txt': 'team' },
  );

  assert.equal(result.status, 'reviewed');
  assert.equal(harness.replacement().files.get('notes.txt').hash, hash('shared-v2'));
  assert.equal(harness.link.hasUnpublishedChanges, false);
});

test('exact hashes detect Shared changes even when contentRevision does not move', async () => {
  const harness = syncHarness({
    sharedFiles: { 'notes.txt': 'changed-without-revision' },
    sharedRevision: 5,
  });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'synced');
  assert.equal(harness.replaceCalls(), 1);
});

test('a revision bump with byte-identical Working content is a no-op', async () => {
  const harness = syncHarness({ sharedRevision: 9 });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'up_to_date');
  assert.equal(harness.replaceCalls(), 0);
});

test('detached links never read or mutate workspace content', async () => {
  const harness = syncHarness({ linkStatus: 'detached', sharedFiles: { 'notes.txt': 'shared-v2' } });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'detached');
  assert.equal(harness.readCalls(), 0);
  assert.equal(harness.replaceCalls(), 0);
  assert.equal(harness.linkUpdates.length, 0);
});

test('archived or unshared Shared workspaces detach without touching private content', async () => {
  for (const option of [
    { sharedStatus: 'archived' as const },
    { sharedStatus: 'unshared' as const },
    { sharedStatus: 'trashed' as const },
    { sharedVisibility: 'private' as const },
    { sharedExists: false },
  ]) {
    const harness = syncHarness(option);
    const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);
    assert.equal(result.status, 'detached');
    assert.equal(harness.replaceCalls(), 0);
    assert.equal(harness.link.status, 'detached');
    assert.equal(harness.link.detachedAt, 'NOW()');
  }
});

test('non-active private workspaces detach without reading or replacing content', async () => {
  for (const privateStatus of ['archived', 'unshared', 'trashed'] as const) {
    const harness = syncHarness({ privateStatus });
    const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);
    assert.equal(result.status, 'detached');
    assert.equal(harness.readCalls(), 0);
    assert.equal(harness.replaceCalls(), 0);
    assert.equal(harness.link.status, 'detached');
  }
});

test('revoked Shared access detaches the link without overwriting', async () => {
  const harness = syncHarness({ sharedAccess: false });

  const result = await harness.service.sync(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'detached');
  assert.equal(harness.replaceCalls(), 0);
  assert.equal(harness.link.status, 'detached');
});

test('reconnect reactivates a valid link but preserves divergent conflicts for review', async () => {
  const harness = syncHarness({
    linkStatus: 'detached',
    privateFiles: { 'notes.txt': 'private-v2' },
    sharedFiles: { 'notes.txt': 'shared-v2' },
    privateRevision: 4,
    sharedRevision: 6,
  });

  const result = await harness.service.reconnect(harness.privateWorkspaceId, harness.userId);

  assert.equal(result.status, 'review_needed');
  assert.equal(harness.link.status, 'active');
  assert.equal(harness.link.detachedAt, null);
  assert.equal(harness.link.reconnectToken, null);
  assert.equal(harness.replaceCalls(), 0);
});

test('legacy clean links initialize an exact base while dirty legacy links fail closed', async () => {
  const clean = syncHarness({
    baseWorkingManifest: false,
    sharedFiles: { 'notes.txt': 'shared-v2' },
    sharedRevision: 6,
  });
  const cleanResult = await clean.service.sync(clean.privateWorkspaceId, clean.userId);
  assert.equal(cleanResult.status, 'synced');
  assert.ok(clean.link.baseWorkingManifest);

  const dirty = syncHarness({
    baseWorkingManifest: false,
    privateFiles: { 'notes.txt': 'private-v2' },
    sharedFiles: { 'notes.txt': 'shared-v2' },
    privateRevision: 4,
    sharedRevision: 6,
  });
  const dirtyResult = await dirty.service.sync(dirty.privateWorkspaceId, dirty.userId);
  assert.equal(dirtyResult.status, 'review_needed');
  assert.equal(dirtyResult.reason, 'BASE_WORKING_MANIFEST_UNAVAILABLE');
  assert.equal(dirty.replaceCalls(), 0);
});
