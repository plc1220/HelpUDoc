import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkspaceService } from '../src/services/workspaceService';

const privateWorkspace = {
  id: 'workspace-private',
  name: 'Private workspace',
  slug: 'private-workspace',
  ownerId: 'owner-user',
  visibility: 'private' as const,
  contentRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * @param options.admins external ids that `users`/`platform_role_bindings` should
 *   report as platform admins.
 * @param options.workspace overrides merged onto the base private workspace.
 */
let nextWorkspaceSuffix = 0;

function workspaceServiceForPrivateWorkspace(options: {
  admins?: string[];
  workspace?: Record<string, unknown>;
} = {}) {
  const admins = new Set(options.admins || []);
  // A distinct id per fixture: the override audit is deduplicated per
  // (user, workspace) for a minute, so two tests sharing an id would have the
  // second one silently observe no audit row.
  const workspace = {
    ...privateWorkspace,
    id: `${privateWorkspace.id}-${nextWorkspaceSuffix += 1}`,
    ...(options.workspace || {}),
  };
  const auditRows: any[] = [];

  const db = ((table: string) => {
    if (table === 'workspaces') {
      return { where: () => ({ first: async () => workspace }) };
    }
    if (table === 'users') {
      return {
        select: () => ({ where: ({ id }: any) => ({ first: async () => ({ isAdmin: admins.has(id) }) }) }),
        where: ({ id }: any) => ({ first: async () => ({ isAdmin: admins.has(id) }) }),
      };
    }
    if (table === 'platform_role_bindings') {
      return { where: ({ userId }: any) => ({ first: async () => (admins.has(userId) ? { userId } : undefined) }) };
    }
    if (table === 'workspace_members') {
      return { where: () => ({ first: async () => undefined }) };
    }
    if (table === 'audit_events') {
      return { insert: async (row: any) => { auditRows.push(row); } };
    }
    throw new Error(`Unexpected query for ${table}`);
  }) as any;

  return { service: new WorkspaceService({ getDb: () => db } as any), auditRows, workspaceId: workspace.id };
}

test('a platform admin reads another user\'s private workspace, but only as a viewer', async () => {
  const { service, auditRows, workspaceId } = workspaceServiceForPrivateWorkspace({ admins: ['platform-admin'] });

  const { membership } = await service.ensureMembership(workspaceId, 'platform-admin', {
    allowSystemAdmin: true,
  });

  assert.equal(membership.role, 'viewer');
  assert.equal(membership.canEdit, false);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'admin.workspace.accessed');
  assert.equal(auditRows[0].platformOverride, true);
  assert.equal(auditRows[0].actorUserId, 'platform-admin');
});

test('the admin override cannot be escalated into a write', async () => {
  const { service, workspaceId } = workspaceServiceForPrivateWorkspace({ admins: ['platform-admin'] });

  await assert.rejects(
    service.ensureMembership(workspaceId, 'platform-admin', {
      requireEdit: true,
      allowSystemAdmin: true,
    }),
    /read-only/,
  );
});

test('a system workspace still grants the override full access', async () => {
  // The Knowledge Library storage workspace is owned by a system identity and
  // reachable by no other route, so global knowledge administration depends on
  // this staying writable. It is the single exception, derived from the record.
  const { service, auditRows, workspaceId } = workspaceServiceForPrivateWorkspace({
    admins: ['platform-admin'],
    workspace: { isSystem: true, visibility: 'team', workspaceType: 'team' },
  });

  const { membership } = await service.ensureMembership(workspaceId, 'platform-admin', {
    requireEdit: true,
    allowSystemAdmin: true,
  });

  assert.equal(membership.role, 'owner');
  assert.equal(membership.canEdit, true);
  // Platform plumbing on a workspace no person owns is not a privacy crossing.
  assert.equal(auditRows.length, 0);
});

test('a non-admin is still refused a private workspace outright', async () => {
  const { service, workspaceId } = workspaceServiceForPrivateWorkspace({ admins: ['platform-admin'] });

  await assert.rejects(
    service.ensureMembership(workspaceId, 'someone-else', { allowSystemAdmin: true }),
    /Private workspace access denied/,
  );
});

test('an admin gets nothing without the override flag', async () => {
  // Ordinary workspace routes never pass `allowSystemAdmin`, so being an admin
  // must not by itself widen access on the normal request path.
  const { service, workspaceId } = workspaceServiceForPrivateWorkspace({ admins: ['platform-admin'] });

  await assert.rejects(
    service.ensureMembership(workspaceId, 'platform-admin', {}),
    /Private workspace access denied/,
  );
});

test('private workspaces authorize only their owner without consulting grants', async () => {
  const { service, workspaceId } = workspaceServiceForPrivateWorkspace();

  const { membership } = await service.ensureMembership(workspaceId, 'owner-user', {
    requireEdit: true,
    allowSystemAdmin: true,
  });

  assert.equal(membership.role, 'owner');
  assert.equal(membership.canEdit, true);
});

test('a purged workspace is unreachable even for its owner', async () => {
  const { service, workspaceId } = workspaceServiceForPrivateWorkspace({
    workspace: { status: 'purged' },
  });

  await assert.rejects(
    service.ensureMembership(workspaceId, 'owner-user', {}),
    /Workspace not found/,
  );
});

function workspaceServiceForSharedWorkspace(
  editingPolicy: 'direct' | 'review',
  role: 'owner' | 'editor' | 'contributor' | 'viewer',
) {
  const sharedWorkspace = {
    ...privateWorkspace,
    id: 'workspace-shared',
    name: 'Shared workspace',
    ownerId: 'owner-user',
    visibility: 'team' as const,
    workspaceType: 'team' as const,
    editingPolicy,
  };
  const membership = {
    workspaceId: sharedWorkspace.id,
    userId: role === 'owner' ? 'owner-user' : 'collaborator-user',
    role,
    canEdit: false,
    createdAt: sharedWorkspace.createdAt,
    updatedAt: sharedWorkspace.updatedAt,
  };
  const db = ((table: string) => {
    if (table === 'workspaces') {
      return { where: () => ({ first: async () => sharedWorkspace }) };
    }
    if (table === 'workspace_members') {
      return { where: () => ({ first: async () => membership }) };
    }
    throw new Error(`Unexpected query for ${table}`);
  }) as any;
  return new WorkspaceService({ getDb: () => db } as any);
}

test('Freeflow contributors can edit the live Shared workspace', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'contributor');
  const { membership } = await service.ensureMembership(
    'workspace-shared',
    'collaborator-user',
    { requireEdit: true },
  );
  assert.equal(membership.canEdit, true);
});

test('Review contributors cannot bypass the proposal boundary with direct writes', async () => {
  const service = workspaceServiceForSharedWorkspace('review', 'contributor');
  await assert.rejects(
    service.ensureMembership('workspace-shared', 'collaborator-user', { requireEdit: true }),
    /uses Review mode/,
  );
});

test('Shared workspace owners retain direct edit access in Review mode', async () => {
  const service = workspaceServiceForSharedWorkspace('review', 'owner');
  const { membership } = await service.ensureMembership(
    'workspace-shared',
    'owner-user',
    { requireEdit: true },
  );
  assert.equal(membership.canEdit, true);
});

test('workspace object bucket denies anonymous download in the GKE deployment', () => {
  const manifest = readFileSync(
    path.resolve(__dirname, '../../infra/gke/k8s/43-minio-setup.yaml'),
    'utf8',
  );
  assert.match(manifest, /mc anonymous set none local\/"\$S3_BUCKET_NAME"/);
  assert.doesNotMatch(manifest, /mc anonymous set download/);
});
