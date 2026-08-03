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

test('workspace object bucket denies anonymous download in the GKE deployment', () => {
  const manifest = readFileSync(
    path.resolve(__dirname, '../../infra/gke/k8s/43-minio-setup.yaml'),
    'utf8',
  );
  assert.match(manifest, /mc anonymous set none local\/"\$S3_BUCKET_NAME"/);
  assert.doesNotMatch(manifest, /mc anonymous set download/);
});
