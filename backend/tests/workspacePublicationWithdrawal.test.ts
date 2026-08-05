import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspacePublicationService } from '../src/services/workspacePublicationService';

type Role = 'owner' | 'editor' | 'contributor' | 'viewer';

function withdrawalHarness(role: Role, currentPublishedVersionId: string | null = 'version-2') {
  const workspace = {
    id: 'workspace-shared',
    name: 'Shared workspace',
    slug: 'shared-workspace',
    ownerId: 'owner-user',
    visibility: 'team' as const,
    workspaceType: 'team' as const,
    editingPolicy: 'direct' as const,
    currentPublishedVersionId,
    contentRevision: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const workspaceUpdates: Record<string, unknown>[] = [];
  const auditEvents: Record<string, unknown>[] = [];

  const tx = ((table: string) => {
    if (table === 'workspaces') {
      return {
        where: () => ({
          forUpdate: () => ({ first: async () => workspace }),
          update: async (payload: Record<string, unknown>) => {
            workspaceUpdates.push(payload);
            return 1;
          },
        }),
      };
    }
    if (table === 'workspace_members') {
      return {
        select: () => ({
          where: () => ({
            forShare: () => ({ first: async () => ({ role }) }),
          }),
        }),
      };
    }
    if (table === 'workspace_published_versions') {
      return {
        where: () => ({
          first: async () => currentPublishedVersionId ? ({
            id: currentPublishedVersionId,
            teamWorkspaceId: workspace.id,
            versionNumber: 2,
          }) : undefined,
        }),
      };
    }
    if (table === 'audit_events') {
      return {
        insert: async (payload: Record<string, unknown>) => {
          auditEvents.push(payload);
          return 1;
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }) as any;
  tx.fn = { now: () => 'database-now' };
  tx.transaction = async (callback: (transaction: typeof tx) => unknown) => callback(tx);

  const workspaceService = {
    ensureMembership: async () => ({
      workspace,
      membership: { role },
    }),
  };
  const service = new WorkspacePublicationService({ getDb: () => tx } as any, workspaceService as any);
  return { service, workspaceUpdates, auditEvents };
}

test('publishers can withdraw the current publication without deleting version history', async () => {
  const { service, workspaceUpdates, auditEvents } = withdrawalHarness('editor');

  const result = await service.withdraw('workspace-shared', 'publisher-user');

  assert.equal(result.withdrawnVersionId, 'version-2');
  assert.equal(result.withdrawnVersionNumber, 2);
  assert.equal(workspaceUpdates.length, 1);
  assert.equal(workspaceUpdates[0].currentPublishedVersionId, null);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, 'workspace.publication_withdrawn');
});

test('contributors cannot withdraw a publication', async () => {
  const { service, workspaceUpdates } = withdrawalHarness('contributor');

  await assert.rejects(
    service.withdraw('workspace-shared', 'contributor-user'),
    /Publisher access is required/,
  );
  assert.equal(workspaceUpdates.length, 0);
});

test('withdrawing requires a current published version', async () => {
  const { service, workspaceUpdates } = withdrawalHarness('owner', null);

  await assert.rejects(
    service.withdraw('workspace-shared', 'owner-user'),
    /does not have a current published version/,
  );
  assert.equal(workspaceUpdates.length, 0);
});
