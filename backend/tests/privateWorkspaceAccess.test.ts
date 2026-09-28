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
    if (table === 'workspace_team_grants as tg') {
      // `resolveTeamGrantRole`: grants the caller reaches through their teams,
      // strongest first. No team grants in these fixtures.
      return {
        join: () => ({
          where: () => ({
            orderByRaw: () => ({ select: () => ({ first: async () => undefined }) }),
          }),
        }),
      };
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
  /** A current locked version makes the workspace read-only for content. */
  currentPublishedVersionId: string | null = null,
  /** 'unshared' keeps `visibility: 'team'` but revokes the audience. */
  status: 'active' | 'unshared' = 'active',
) {
  const sharedWorkspace = {
    ...privateWorkspace,
    id: 'workspace-shared',
    name: 'Shared workspace',
    ownerId: 'owner-user',
    visibility: 'team' as const,
    workspaceType: 'team' as const,
    editingPolicy,
    currentPublishedVersionId,
    status,
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
      return {
        where: () => ({ first: async () => sharedWorkspace }),
        // `getMcpServerPolicy` re-reads a narrow column set of its own.
        select: () => ({ where: () => ({ first: async () => sharedWorkspace }) }),
      };
    }
    if (table === 'workspace_members') {
      return { where: () => ({ first: async () => membership }) };
    }
    if (table === 'mcp_server_grants') {
      return { select: () => ({ where: async () => [] }) };
    }
    if (table === 'workspace_team_grants as tg') {
      // `resolveTeamGrantRole`: grants the caller reaches through their teams,
      // strongest first. No team grants in these fixtures.
      return {
        join: () => ({
          where: () => ({
            orderByRaw: () => ({ select: () => ({ first: async () => undefined }) }),
          }),
        }),
      };
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

// ─── Locked Shared workspaces ────────────────────────────────────────────────
//
// Locking used to be pure bookkeeping — it wrote a snapshot and left the live
// workspace as writable as before, which is how a contributor could edit a
// "locked" workspace and then find nothing would accept the result.

test('a locked Shared workspace refuses a content write from its own owner', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'owner', 'version-1');
  await assert.rejects(
    service.ensureMembership('workspace-shared', 'owner-user', { requireEdit: true }),
    (error: any) => error.statusCode === 409
      && error.details?.code === 'WORKSPACE_CONTENT_LOCKED',
  );
});

test('a locked Shared workspace refuses a Freeflow contributor', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'contributor', 'version-1');
  await assert.rejects(
    service.ensureMembership('workspace-shared', 'collaborator-user', { requireEdit: true }),
    (error: any) => error.details?.code === 'WORKSPACE_CONTENT_LOCKED',
  );
});

test('a viewer in a locked workspace is told they are a viewer, not that it is locked', async () => {
  // Guard order matters: pointing a viewer at a private copy they may not
  // create would send them down a path that dead-ends.
  const service = workspaceServiceForSharedWorkspace('direct', 'viewer', 'version-1');
  await assert.rejects(
    service.ensureMembership('workspace-shared', 'collaborator-user', { requireEdit: true }),
    /read-only for this user/,
  );
});

test('requireEditRole ignores the lock so reads keep working', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'contributor', 'version-1');
  const { membership } = await service.ensureMembership(
    'workspace-shared',
    'collaborator-user',
    { requireEditRole: true },
  );
  // The role would permit editing; the lock is why it cannot happen right now.
  assert.equal(membership.canEdit, false);
});

test('requireEditRole still refuses a viewer', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'viewer', 'version-1');
  await assert.rejects(
    service.ensureMembership('workspace-shared', 'collaborator-user', { requireEditRole: true }),
    /read-only for this user/,
  );
});

test('withdrawing the lock restores direct editing', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'contributor', null);
  const { membership } = await service.ensureMembership(
    'workspace-shared',
    'collaborator-user',
    { requireEdit: true },
  );
  assert.equal(membership.canEdit, true);
});

test('a locked workspace reports canWriteWorkspace false to the agent', async () => {
  const service = workspaceServiceForSharedWorkspace('direct', 'owner', 'version-1');
  const policy = await service.getMcpServerPolicy('workspace-shared', 'owner-user');
  assert.equal(policy.canWriteWorkspace, false);
  // Deliberately still `shared_live`: `published_read_only` additionally
  // collapses the runtime skill list to pinned-only, which would silently strip
  // every skill from a locked workspace that has no pins.
  assert.equal(policy.workspaceMode, 'shared_live');
});

test('an unshared workspace lets the owner\'s agent write, as the owner can by hand', async () => {
  // Unsharing leaves `visibility: 'team'`. The agent policy used to read that
  // alone, so the owner could still edit files by hand while the agent was
  // told it could not write.
  const service = workspaceServiceForSharedWorkspace('direct', 'owner', null, 'unshared');
  const { membership } = await service.ensureMembership('workspace-shared', 'owner-user');
  const policy = await service.getMcpServerPolicy('workspace-shared', 'owner-user');
  assert.equal(membership.canEdit, true);
  assert.equal(policy.canWriteWorkspace, true);
  // Not `shared_live`: Team Chat's agent gates on that mode, and the chat is
  // frozen once the workspace is unshared.
  assert.equal(policy.workspaceMode, 'private');
  assert.equal(policy.editingPolicy, null);
});

test('an unshared Review-mode workspace also lets the owner\'s agent write', async () => {
  // Review mode routes a shared audience's edits through proposals. With no
  // audience left, it must not block the owner's agent.
  const service = workspaceServiceForSharedWorkspace('review', 'owner', null, 'unshared');
  const policy = await service.getMcpServerPolicy('workspace-shared', 'owner-user');
  assert.equal(policy.canWriteWorkspace, true);
});

test('an unshared workspace that is still locked stays read-only to the agent', async () => {
  // The lock outlives unsharing. The owner cannot edit by hand, so the agent
  // must not either.
  const service = workspaceServiceForSharedWorkspace('direct', 'owner', 'version-1', 'unshared');
  const policy = await service.getMcpServerPolicy('workspace-shared', 'owner-user');
  assert.equal(policy.canWriteWorkspace, false);
});

test('workspace object bucket denies anonymous download in the GKE deployment', () => {
  const manifest = readFileSync(
    path.resolve(__dirname, '../../infra/gke/k8s/43-minio-setup.yaml'),
    'utf8',
  );
  assert.match(manifest, /mc anonymous set none local\/"\$S3_BUCKET_NAME"/);
  assert.doesNotMatch(manifest, /mc anonymous set download/);
});
