/**
 * Tests for linked private draft sync-status derivation in listWorkspacesForUser.
 *
 * The bug: teamChanged was computed by comparing published version IDs, so a
 * Shared Working content change (without a new published version) was invisible
 * to linked private drafts. The fix compares linked_team.contentRevision against
 * private_link.baseSharedContentRevision when that field is available.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceService } from '../src/services/workspaceService.ts';

type SyncHarnessOptions = {
  privateContentRevision?: number;
  basePrivateContentRevision?: number;
  hasUnpublishedChanges?: boolean;
  linkedTeamContentRevision?: number;
  baseSharedContentRevision?: number | null;
  linkedTeamCurrentPublishedVersionId?: string | null;
  basePublishedVersionId?: string | null;
  hasTeamMembership?: boolean;
  linkedTeamUpdatedAt?: string | Date | null;
  linkedTeamFilesUpdatedAt?: string | Date | null;
  publicationLinkUpdatedAt?: string | Date | null;
  publicationLinkStatus?: 'active' | 'detached';
  linkedTeamStatus?: 'active' | 'unshared' | 'trashed';
};

function syncStatusHarness(options: SyncHarnessOptions = {}) {
  const {
    privateContentRevision = 3,
    basePrivateContentRevision = 3,
    hasUnpublishedChanges = false,
    linkedTeamContentRevision = 5,
    baseSharedContentRevision = 5,
    linkedTeamCurrentPublishedVersionId = null,
    basePublishedVersionId = null,
    hasTeamMembership = true,
    linkedTeamUpdatedAt = null,
    linkedTeamFilesUpdatedAt = null,
    publicationLinkUpdatedAt = null,
    publicationLinkStatus = 'active',
    linkedTeamStatus = 'active',
  } = options;

  const userId = 'user-1';
  const privateWorkspaceId = 'ws-private';
  const teamWorkspaceId = 'ws-team';

  const row = {
    id: privateWorkspaceId,
    name: 'Testing List Mcp Servers',
    slug: 'testing-list-mcp-servers',
    ownerId: userId,
    lastModifiedBy: userId,
    visibility: 'private',
    workspaceType: 'private',
    editingPolicy: null,
    teamId: null,
    currentPublishedVersionId: null,
    contentRevision: privateContentRevision,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    isSystem: false,
    directRole: 'owner',
    directCanEdit: true,
    teamMemberUserId: null,
    teamGrantRole: null,
    teamName: null,
    linkedTeamWorkspaceId: teamWorkspaceId,
    linkedTeamId: 'team-1',
    linkedTeamCurrentPublishedVersionId,
    basePublishedVersionId,
    basePrivateContentRevision,
    baseSharedContentRevision,
    linkedTeamContentRevision,
    linkedTeamUpdatedAt,
    linkedTeamFilesUpdatedAt,
    publicationLinkUpdatedAt,
    publicationLinkStatus,
    linkedTeamStatus,
    hasUnpublishedChanges,
    linkedTeamRole: hasTeamMembership ? 'contributor' : null,
    linkedTeamGroupMemberUserId: hasTeamMembership ? userId : null,
    privateCopyWorkspaceId: null,
    currentPublishedVersionNumber: null,
    publishedContentRevision: null,
    lastPublishedAt: null,
    latestPublisherName: null,
    publishedVersionCount: 0,
    pendingProposalCount: 0,
  };

  const db = ((table: string) => {
    if (table === 'workspaces as w') {
      return {
        leftJoin: () => stubChain(),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  }) as any;
  db.raw = (expr: string) => expr;

  function stubChain(): any {
    return new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'distinct') return (..._args: unknown[]) => stubChain();
        if (prop === 'where') return (..._args: unknown[]) => stubChain();
        if (prop === 'andWhere') return (..._args: unknown[]) => stubChain();
        if (prop === 'orderBy') return (..._args: unknown[]) => Promise.resolve([row]);
        return (..._args: unknown[]) => stubChain();
      },
    });
  }

  const service = Object.create(WorkspaceService.prototype) as WorkspaceService;
  Object.assign(service, { db });
  return { service, userId };
}

/**
 * Harness for a Shared (team-visibility) workspace row, used to assert that the
 * legacy timestamp fallback does not leak into shared publication semantics.
 */
function sharedWorkspaceHarness(options: {
  contentRevision?: number;
  publishedContentRevision?: number | null;
  updatedAt?: string;
  status?: 'active' | 'unshared' | 'trashed';
  unsharedAt?: string | null;
  trashedAt?: string | null;
  purgeAfter?: string | null;
} = {}) {
  const {
    contentRevision = 4,
    publishedContentRevision = 4,
    updatedAt = '2026-08-06T10:00:00.000Z',
    status = 'active',
    unsharedAt = null,
    trashedAt = null,
    purgeAfter = null,
  } = options;

  const userId = 'user-1';
  const row = {
    id: 'ws-team',
    name: 'Testing',
    slug: 'testing',
    ownerId: userId,
    lastModifiedBy: userId,
    visibility: 'team',
    workspaceType: 'team',
    editingPolicy: 'review',
    status,
    unsharedAt,
    trashedAt,
    purgeAfter,
    teamId: 'team-1',
    currentPublishedVersionId: 'version-1',
    contentRevision,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
    isSystem: false,
    directRole: 'owner',
    directCanEdit: true,
    teamMemberUserId: userId,
    teamGrantRole: 'contributor',
    teamName: 'Team One',
    linkedTeamWorkspaceId: null,
    linkedTeamId: null,
    linkedTeamCurrentPublishedVersionId: null,
    linkedTeamUpdatedAt: null,
    publicationLinkUpdatedAt: null,
    basePublishedVersionId: null,
    basePrivateContentRevision: null,
    baseSharedContentRevision: null,
    linkedTeamContentRevision: null,
    hasUnpublishedChanges: false,
    linkedTeamRole: null,
    linkedTeamGroupMemberUserId: null,
    privateCopyWorkspaceId: null,
    currentPublishedVersionNumber: 1,
    publishedContentRevision,
    lastPublishedAt: '2026-08-02T00:00:00.000Z',
    latestPublisherName: 'User One',
    publishedVersionCount: 1,
    pendingProposalCount: 0,
  };

  const db = ((table: string) => {
    if (table === 'workspaces as w') {
      return { leftJoin: () => stubChain() };
    }
    throw new Error(`Unexpected table: ${table}`);
  }) as any;
  db.raw = (expr: string) => expr;

  function stubChain(): any {
    return new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'orderBy') return (..._args: unknown[]) => Promise.resolve([row]);
        return (..._args: unknown[]) => stubChain();
      },
    });
  }

  const service = Object.create(WorkspaceService.prototype) as WorkspaceService;
  Object.assign(service, { db });
  return { service, userId };
}

// ─── Shared Working revision-based sync ──────────────────────────────────────

test('linked draft shows team_updates_available when only Shared Working contentRevision advances', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 6,
    baseSharedContentRevision: 5,
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('linked draft shows review_needed when both Shared and private revisions advance', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 6,
    baseSharedContentRevision: 5,
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'review_needed');
});

test('linked draft shows up_to_date when no revisions have changed', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 5,
    baseSharedContentRevision: 5,
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('linked draft shows changes_to_publish when only private revision advances', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 5,
    baseSharedContentRevision: 5,
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'changes_to_publish');
});

test('linked draft reports detached when its publication link is detached', async () => {
  const { service, userId } = syncStatusHarness({ publicationLinkStatus: 'detached' });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'detached');
});

test('linked draft reports detached when the Shared workspace is not active', async () => {
  const { service, userId } = syncStatusHarness({ linkedTeamStatus: 'unshared' });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'detached');
});

// ─── Backwards-compatible published-version fallback ─────────────────────────

test('falls back to published-version comparison when baseSharedContentRevision is null', async () => {
  const { service, userId } = syncStatusHarness({
    baseSharedContentRevision: null,
    linkedTeamCurrentPublishedVersionId: 'version-2',
    basePublishedVersionId: 'version-1',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('falls back to published-version comparison when baseSharedContentRevision is zero', async () => {
  const { service, userId } = syncStatusHarness({
    baseSharedContentRevision: 0,
    linkedTeamCurrentPublishedVersionId: 'version-2',
    basePublishedVersionId: 'version-1',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('fallback shows up_to_date when published versions match', async () => {
  const { service, userId } = syncStatusHarness({
    baseSharedContentRevision: 0,
    linkedTeamCurrentPublishedVersionId: 'version-2',
    basePublishedVersionId: 'version-2',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

// ─── needsInitialPublication must not mask real revision changes ──────────────

test('no-published-version draft with known shared revision still detects team changes', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    linkedTeamContentRevision: 6,
    baseSharedContentRevision: 5,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('needsInitialPublication only triggers when baseSharedContentRevision is unavailable', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamCurrentPublishedVersionId: null,
    basePublishedVersionId: null,
    baseSharedContentRevision: 0,
    linkedTeamContentRevision: 5,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'changes_to_publish');
});

// ─── Legacy timestamp fallback ────────────────────────────────────────────────

test('linked draft detects team updates when Shared workspace updatedAt is later than the link', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 3,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-06T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('timestamp fallback accepts Date instances from the driver', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: new Date('2026-08-06T10:00:00.000Z'),
    publicationLinkUpdatedAt: new Date('2026-08-05T10:00:00.000Z'),
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('timestamp fallback combines with private changes into review_needed', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-06T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'review_needed');
});

test('timestamp fallback stays up_to_date when the link was updated after the Shared workspace', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-05T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-06T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('timestamp fallback stays up_to_date when timestamps are equal', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-06T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-06T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('timestamp fallback is skipped when the publication link has no timestamp', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-06T10:00:00.000Z',
    publicationLinkUpdatedAt: null,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('timestamp fallback is skipped when the Shared workspace has no timestamp', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: null,
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('a linked draft reports detached when Shared access is revoked', async () => {
  const { service, userId } = syncStatusHarness({
    hasTeamMembership: false,
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-06T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'detached');
});

test('legacy published-version fallback still applies alongside timestamps', async () => {
  const { service, userId } = syncStatusHarness({
    baseSharedContentRevision: null,
    linkedTeamCurrentPublishedVersionId: 'version-2',
    basePublishedVersionId: 'version-1',
    linkedTeamUpdatedAt: '2026-08-05T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-06T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('shared workspace publication status ignores the timestamp fallback', async () => {
  const { service, userId } = sharedWorkspaceHarness({
    contentRevision: 4,
    publishedContentRevision: 4,
    updatedAt: '2026-08-06T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('owner lifecycle rows are read-only and expose trash metadata', async () => {
  const trashedAt = '2026-08-07T10:00:00.000Z';
  const purgeAfter = '2026-09-06T10:00:00.000Z';
  const { service, userId } = sharedWorkspaceHarness({
    status: 'trashed',
    trashedAt,
    purgeAfter,
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].status, 'trashed');
  assert.equal(workspaces[0].trashedAt, trashedAt);
  assert.equal(workspaces[0].purgeAfter, purgeAfter);
  assert.equal(workspaces[0].canEdit, false);
  assert.equal(workspaces[0].canPublish, false);
});

test('an unshared owner can keep editing but cannot publish until reshare', async () => {
  const { service, userId } = sharedWorkspaceHarness({
    status: 'unshared',
    unsharedAt: '2026-08-07T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].canEdit, true);
  assert.equal(workspaces[0].canPublish, false);
});

// ─── File-level timestamp drift (direct file insertion without workspace bump) ─

test('file-level updatedAt detects changes when workspace updatedAt is stale', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-04T10:00:00.000Z',
    linkedTeamFilesUpdatedAt: '2026-08-06T12:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});

test('file-level updatedAt combines with private changes into review_needed', async () => {
  const { service, userId } = syncStatusHarness({
    privateContentRevision: 4,
    basePrivateContentRevision: 3,
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-04T10:00:00.000Z',
    linkedTeamFilesUpdatedAt: '2026-08-06T12:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'review_needed');
});

test('file-level updatedAt equal to link updatedAt stays up_to_date', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-04T10:00:00.000Z',
    linkedTeamFilesUpdatedAt: '2026-08-05T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('file-level updatedAt older than link updatedAt stays up_to_date', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-04T10:00:00.000Z',
    linkedTeamFilesUpdatedAt: '2026-08-04T10:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('file-level updatedAt null with stale workspace updatedAt stays up_to_date', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: '2026-08-04T10:00:00.000Z',
    linkedTeamFilesUpdatedAt: null,
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'up_to_date');
});

test('file-level updatedAt detects drift even when workspace and link have no timestamps', async () => {
  const { service, userId } = syncStatusHarness({
    linkedTeamContentRevision: 1,
    baseSharedContentRevision: 1,
    linkedTeamUpdatedAt: null,
    linkedTeamFilesUpdatedAt: '2026-08-06T12:00:00.000Z',
    publicationLinkUpdatedAt: '2026-08-05T10:00:00.000Z',
  });
  const workspaces = await service.listWorkspacesForUser(userId);
  assert.equal(workspaces[0].publicationStatus, 'team_updates_available');
});
