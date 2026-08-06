/**
 * Tests for the Shared Working sync path in WorkspacePublicationService.sync().
 *
 * Covers:
 * - Modern links (baseSharedContentRevision > 0) sync from live Shared Working
 *   content without requiring a published version.
 * - Unchanged Shared Working returns up_to_date immediately.
 * - Mixed changes (both sides advanced, no usable published base) fail closed
 *   with REVIEW_NEEDED.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspacePublicationService } from '../src/services/workspacePublicationService.ts';

type SyncHarnessOptions = {
  privateContentRevision?: number;
  basePrivateContentRevision?: number;
  baseSharedContentRevision?: number;
  basePublishedVersionId?: string | null;
  hasUnpublishedChanges?: boolean;
  teamContentRevision?: number;
  teamCurrentPublishedVersionId?: string | null;
  teamUpdatedAt?: string | Date | null;
  teamFilesUpdatedAt?: string | Date | null;
  linkUpdatedAt?: string | Date | null;
};

function sharedWorkingSyncHarness(options: SyncHarnessOptions = {}) {
  const {
    privateContentRevision = 3,
    basePrivateContentRevision = 3,
    baseSharedContentRevision = 5,
    basePublishedVersionId = null,
    hasUnpublishedChanges = false,
    teamContentRevision = 6,
    teamCurrentPublishedVersionId = null,
    teamUpdatedAt = '2026-08-06T00:00:00.000Z',
    teamFilesUpdatedAt = null as string | Date | null,
    linkUpdatedAt = '2026-08-05T00:00:00.000Z',
  } = options;

  const userId = 'user-1';
  const privateWorkspaceId = 'ws-private';
  const teamWorkspaceId = 'ws-team';

  const privateWorkspace = {
    id: privateWorkspaceId,
    name: 'My Draft',
    slug: 'my-draft',
    ownerId: userId,
    visibility: 'private' as const,
    contentRevision: privateContentRevision,
  };

  const teamWorkspace = {
    id: teamWorkspaceId,
    name: 'Shared workspace',
    slug: 'shared-workspace',
    ownerId: userId,
    visibility: 'team' as const,
    contentRevision: teamContentRevision,
    currentPublishedVersionId: teamCurrentPublishedVersionId,
    updatedAt: teamUpdatedAt,
  };

  const link = {
    privateWorkspaceId,
    teamWorkspaceId,
    userId,
    basePublishedVersionId,
    basePrivateContentRevision,
    baseSharedContentRevision,
    hasUnpublishedChanges,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: linkUpdatedAt,
  };

  let replaceContentCalled = false;
  let linkUpdates: Record<string, unknown> = {};

  const db = ((table: string) => {
    if (table === 'workspace_publication_links') {
      return {
        where: () => ({
          first: async () => link,
          update: async (payload: Record<string, unknown>) => {
            linkUpdates = payload;
            return 1;
          },
        }),
      };
    }
    if (table === 'files') {
      return {
        where: () => ({
          max: () => ({
            first: async () => ({ maxUpdatedAt: teamFilesUpdatedAt }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  }) as any;
  db.fn = { now: () => 'NOW()' };

  const service = Object.create(WorkspacePublicationService.prototype) as WorkspacePublicationService;
  Object.assign(service, {
    db,
    workspaceService: {
      ensureMembership: async (workspaceId: string, _userId: string, _opts?: unknown) => {
        if (workspaceId === privateWorkspaceId) {
          return { workspace: privateWorkspace, membership: { role: 'owner' } };
        }
        return { workspace: teamWorkspace, membership: { role: 'contributor' } };
      },
    },
    readWorkspaceContent: async (_id: string) => ({
      files: new Map([
        ['testing2.txt', {
          name: 'testing2.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('shared content'),
          hash: 'hash-shared',
          size: 14,
        }],
      ]),
      folders: [],
    }),
    replaceWorkspaceContent: async (
      _workspaceId: string,
      _content: unknown,
      _userId: string,
      _tx?: unknown,
      afterUpdate?: (tx: unknown, rev: number) => Promise<void>,
    ) => {
      replaceContentCalled = true;
      const fakeTx = ((table: string) => {
        if (table === 'workspace_publication_links') {
          return {
            where: () => ({
              update: async (payload: Record<string, unknown>) => {
                linkUpdates = payload;
                return 1;
              },
            }),
          };
        }
        return { where: () => ({ del: async () => 0, insert: async () => [] }) };
      }) as any;
      fakeTx.fn = { now: () => 'NOW()' };
      if (afterUpdate) await afterUpdate(fakeTx, teamContentRevision + 1);
      return teamContentRevision + 1;
    },
    copyPublishedSkillPinsToWorkspace: async () => {},
  });

  return { service, userId, replaceContentCalled: () => replaceContentCalled, linkUpdates: () => linkUpdates };
}

// ─── Shared-only drift: sync successfully without a published version ────────

test('sync replaces private draft with Shared Working content when only shared side advanced', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 6,
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    hasUnpublishedChanges: false,
  });

  const result = await harness.service.sync('ws-private', 'user-1');

  assert.equal(result.status, 'synced');
  assert.equal(result.workspaceId, 'ws-private');
  assert.equal(result.teamWorkspaceId, 'ws-team');
  assert.deepEqual(result.conflicts, []);
  assert.ok(harness.replaceContentCalled());

  const updates = harness.linkUpdates();
  assert.equal(updates.baseSharedContentRevision, 6);
  assert.equal(updates.hasUnpublishedChanges, false);
  assert.equal(updates.basePublishedVersionId, null);
});

// ─── Unchanged Shared Working returns up_to_date ─────────────────────────────

test('sync returns up_to_date when Shared Working revision has not advanced', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    hasUnpublishedChanges: false,
    teamUpdatedAt: '2026-08-05T00:00:00.000Z',
    linkUpdatedAt: '2026-08-05T00:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');

  assert.equal(result.status, 'up_to_date');
  assert.deepEqual(result.conflicts, []);
  assert.ok(!harness.replaceContentCalled());
});

// ─── Mixed changes fail closed with REVIEW_NEEDED ────────────────────────────

test('sync throws REVIEW_NEEDED when both Shared and private have changed without a published base', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 6,
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    hasUnpublishedChanges: false,
  });

  await assert.rejects(
    () => harness.service.sync('ws-private', 'user-1'),
    (error: any) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Review and merge manually/);
      assert.equal(error.details?.code, 'REVIEW_NEEDED');
      assert.equal(error.details?.privateContentRevision, 4);
      assert.equal(error.details?.sharedContentRevision, 6);
      return true;
    },
  );
  assert.ok(!harness.replaceContentCalled());
});

test('sync throws REVIEW_NEEDED when hasUnpublishedChanges is true even if revision matches', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 6,
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    hasUnpublishedChanges: true,
  });

  await assert.rejects(
    () => harness.service.sync('ws-private', 'user-1'),
    (error: any) => {
      assert.equal(error.details?.code, 'REVIEW_NEEDED');
      return true;
    },
  );
});

// ─── Timestamp-only Shared Working changes trigger sync ──────────────────────

test('sync detects Shared Working file changes via timestamp when contentRevision did not increment', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5, // same as base — no revision bump
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    hasUnpublishedChanges: false,
    teamUpdatedAt: '2026-08-06T12:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');

  assert.equal(result.status, 'synced');
  assert.equal(result.workspaceId, 'ws-private');
  assert.equal(result.teamWorkspaceId, 'ws-team');
  assert.deepEqual(result.conflicts, []);
  assert.ok(harness.replaceContentCalled());

  const updates = harness.linkUpdates();
  assert.equal(updates.baseSharedContentRevision, 5);
  assert.equal(updates.hasUnpublishedChanges, false);
});

test('sync detects timestamp change with Date instances from the database driver', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: new Date('2026-08-06T12:00:00.000Z'),
    linkUpdatedAt: new Date('2026-08-05T10:00:00.000Z'),
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'synced');
  assert.ok(harness.replaceContentCalled());
});

test('sync remains up_to_date when timestamps are equal and revision unchanged', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-05T10:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('sync remains up_to_date when link timestamp is later than Shared workspace', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-05T10:00:00.000Z',
    linkUpdatedAt: '2026-08-06T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('sync skips timestamp fallback when Shared workspace has no timestamp', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: null,
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('sync skips timestamp fallback when link has no timestamp', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-06T10:00:00.000Z',
    linkUpdatedAt: null,
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('timestamp-only change with private changes throws REVIEW_NEEDED', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-06T12:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  await assert.rejects(
    () => harness.service.sync('ws-private', 'user-1'),
    (error: any) => {
      assert.equal(error.details?.code, 'REVIEW_NEEDED');
      return true;
    },
  );
  assert.ok(!harness.replaceContentCalled());
});

// ─── Legacy links still use the published-version path ───────────────────────

test('sync with baseSharedContentRevision=0 falls back to published-version path and throws if none', async () => {
  const harness = sharedWorkingSyncHarness({
    baseSharedContentRevision: 0,
    teamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
  });

  await assert.rejects(
    () => harness.service.sync('ws-private', 'user-1'),
    /No published Team version is available to sync/,
  );
});

// ─── File-level timestamp drift (direct file insertion without workspace bump) ─

test('sync detects file-level updatedAt drift when workspace updatedAt is stale', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-04T10:00:00.000Z',
    teamFilesUpdatedAt: '2026-08-06T12:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'synced');
  assert.ok(harness.replaceContentCalled());
});

test('sync stays up_to_date when file-level updatedAt equals link updatedAt', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-04T10:00:00.000Z',
    teamFilesUpdatedAt: '2026-08-05T10:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('sync stays up_to_date when file-level updatedAt is older than link', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-04T10:00:00.000Z',
    teamFilesUpdatedAt: '2026-08-04T00:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});

test('file-level drift with private changes throws REVIEW_NEEDED', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-04T10:00:00.000Z',
    teamFilesUpdatedAt: '2026-08-06T12:00:00.000Z',
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  await assert.rejects(
    () => harness.service.sync('ws-private', 'user-1'),
    (error: any) => {
      assert.equal(error.details?.code, 'REVIEW_NEEDED');
      return true;
    },
  );
  assert.ok(!harness.replaceContentCalled());
});

test('file-level drift null falls back to workspace-level timestamp only', async () => {
  const harness = sharedWorkingSyncHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    baseSharedContentRevision: 5,
    teamContentRevision: 5,
    teamUpdatedAt: '2026-08-04T10:00:00.000Z',
    teamFilesUpdatedAt: null,
    linkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });

  const result = await harness.service.sync('ws-private', 'user-1');
  assert.equal(result.status, 'up_to_date');
  assert.ok(!harness.replaceContentCalled());
});
