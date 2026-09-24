import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkspaceService } from '../src/services/workspaceService';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';

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

function workspaceServiceForPrivateWorkspace() {
  const db = ((table: string) => {
    if (table === 'workspaces') {
      return {
        where: () => ({
          first: async () => privateWorkspace,
        }),
      };
    }
    // A private-workspace request must be rejected before an administrator
    // lookup or membership lookup is attempted.
    throw new Error(`Unexpected query for ${table}`);
  }) as any;

  return new WorkspaceService({ getDb: () => db } as any);
}

test('private workspaces reject a platform-admin override for another user', async () => {
  const service = workspaceServiceForPrivateWorkspace();

  await assert.rejects(
    service.ensureMembership(privateWorkspace.id, 'platform-admin', {
      requireEdit: true,
      allowSystemAdmin: true,
    }),
    /Private workspace access denied/,
  );
});

test('private workspaces authorize only their owner without consulting grants', async () => {
  const service = workspaceServiceForPrivateWorkspace();

  const { membership } = await service.ensureMembership(privateWorkspace.id, 'owner-user', {
    requireEdit: true,
    allowSystemAdmin: true,
  });

  assert.equal(membership.role, 'owner');
  assert.equal(membership.canEdit, true);
});

test('personal annotation CRUD rejects other users before reading or writing any comment data', async () => {
  const db = (() => { throw new Error('Annotation data must not be accessed'); }) as any;
  const service = new WorkspaceCollaborationService({ getDb: () => db } as any, workspaceServiceForPrivateWorkspace(), {} as any);
  for (const operation of [
    () => service.listObjects(privateWorkspace.id, 'another-user'),
    () => service.getObject(privateWorkspace.id, 'annotation', 'another-user'),
    () => service.createObject(privateWorkspace.id, 'another-user', { type: 'annotation', visibility: 'private', body: 'Comment' }),
    () => service.appendMessage(privateWorkspace.id, 'annotation', 'another-user', 'Reply'),
    () => service.updateObject(privateWorkspace.id, 'annotation', 'another-user', { status: 'resolved' }),
  ]) {
    await assert.rejects(operation(), /Private workspace access denied/);
  }
});

test('personal annotation reads enforce object workspace, author, visibility, and type', async () => {
  let object = { id: 'annotation', workspaceId: privateWorkspace.id, authorId: 'owner-user', type: 'annotation', visibility: 'private' };
  const db = ((table: string) => {
    const filters: Record<string, string> = {};
    const query: any = {
      leftJoin: () => query,
      select: () => query,
      where(key: string, value: string) { filters[key.split('.').pop()!] = value; return query; },
      andWhere(key: string, value: string) { return query.where(key, value); },
      first: async () => Object.entries(filters).every(([key, value]) => object[key as keyof typeof object] === value) ? object : undefined,
      orderBy: async () => [],
    };
    assert.ok(['workspace_collaboration_objects as object', 'workspace_collaboration_messages as message'].includes(table));
    return query;
  }) as any;
  db.raw = () => '';
  const service = new WorkspaceCollaborationService({ getDb: () => db } as any, workspaceServiceForPrivateWorkspace(), {} as any);
  assert.equal((await service.getObject(privateWorkspace.id, 'annotation', 'owner-user')).object.id, 'annotation');
  const original = object;
  for (const change of [{ workspaceId: 'different-workspace' }, { authorId: 'another-user' }, { visibility: 'workspace_audience' }, { type: 'task' }]) {
    object = { ...original, ...change };
    await assert.rejects(service.getObject(privateWorkspace.id, 'annotation', 'owner-user'), /Collaboration item not found/);
  }
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
