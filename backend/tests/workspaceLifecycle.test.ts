import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceService } from '../src/services/workspaceService';

type Row = Record<string, any>;

class InsertBuilder implements PromiseLike<any> {
  private conflictColumns: string[] = [];
  private mergeValues: Row | null = null;

  constructor(
    private readonly table: Row[],
    private readonly values: Row,
  ) {}

  onConflict(columns: string[]): this {
    this.conflictColumns = columns;
    return this;
  }

  merge(values: Row): this {
    this.mergeValues = values;
    return this;
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => {
      const existing = this.conflictColumns.length
        ? this.table.find((row) => this.conflictColumns.every((column) => row[column] === this.values[column]))
        : undefined;
      if (existing && this.mergeValues) Object.assign(existing, this.mergeValues);
      else if (!existing) this.table.push({ ...this.values });
      return [existing || this.values];
    }).then(onfulfilled, onrejected);
  }
}

class Query implements PromiseLike<Row[]> {
  private predicates: Array<(row: Row) => boolean> = [];

  constructor(private readonly rows: Row[]) {}

  where(criteria: Row): this {
    this.predicates.push((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
    return this;
  }

  forUpdate(): this {
    return this;
  }

  private matching(): Row[] {
    return this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
  }

  async first(): Promise<Row | undefined> {
    return this.matching()[0];
  }

  async update(values: Row): Promise<number> {
    const matching = this.matching();
    matching.forEach((row) => Object.assign(row, values));
    return matching.length;
  }

  async del(): Promise<number> {
    const matching = new Set(this.matching());
    const before = this.rows.length;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (matching.has(this.rows[index])) this.rows.splice(index, 1);
    }
    return before - this.rows.length;
  }

  insert(values: Row): InsertBuilder {
    return new InsertBuilder(this.rows, values);
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.matching()).then(onfulfilled, onrejected);
  }
}

function lifecycleHarness() {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const collaboratorId = '33333333-3333-4333-8333-333333333333';
  const nextOwnerId = '44444444-4444-4444-8444-444444444444';
  const timestamps = {
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
  const tables: Record<string, Row[]> = {
    workspaces: [{
      id: workspaceId,
      ownerId,
      name: 'Shared',
      slug: 'shared',
      visibility: 'team',
      workspaceType: 'team',
      editingPolicy: 'direct',
      status: 'active',
      contentRevision: 1,
      ...timestamps,
    }],
    workspace_members: [
      { workspaceId, userId: ownerId, role: 'owner', canEdit: true, ...timestamps },
      { workspaceId, userId: collaboratorId, role: 'editor', canEdit: true, ...timestamps },
      { workspaceId, userId: nextOwnerId, role: 'viewer', canEdit: false, ...timestamps },
    ],
    workspace_user_grants: [
      { workspaceId, userId: collaboratorId, role: 'publisher' },
      { workspaceId, userId: nextOwnerId, role: 'viewer' },
    ],
    workspace_publication_links: [{
      privateWorkspaceId: '55555555-5555-4555-8555-555555555555',
      teamWorkspaceId: workspaceId,
      userId: collaboratorId,
      status: 'active',
      detachedAt: null,
    }],
    users: [
      { id: ownerId },
      { id: collaboratorId },
      { id: nextOwnerId },
    ],
    audit_events: [],
  };
  const db = ((table: string) => new Query(tables[table] || (tables[table] = []))) as any;
  db.fn = { now: () => new Date('2026-08-10T01:00:00.000Z') };
  db.transaction = async (operation: (tx: any) => Promise<unknown>) => operation(db);
  const service = Object.create(WorkspaceService.prototype) as WorkspaceService;
  Object.assign(service, { db });
  return { service, tables, workspaceId, ownerId, collaboratorId, nextOwnerId };
}

test('unshare revokes access without deleting grants and reshare leaves private links detached', async () => {
  const { service, tables, workspaceId, ownerId, collaboratorId } = lifecycleHarness();

  await service.unshareWorkspace(workspaceId, ownerId);
  assert.equal(tables.workspaces[0].status, 'unshared');
  assert.equal(tables.workspace_members.length, 3);
  assert.equal(tables.workspace_user_grants.length, 2);
  assert.equal(tables.workspace_publication_links[0].status, 'detached');
  await assert.rejects(service.ensureMembership(workspaceId, collaboratorId), /no longer shared/);

  await service.reshareWorkspace(workspaceId, ownerId);
  assert.equal(tables.workspaces[0].status, 'active');
  assert.equal(tables.workspace_publication_links[0].status, 'detached');
  const { membership } = await service.ensureMembership(workspaceId, collaboratorId);
  assert.equal(membership.role, 'editor');
});

test('restoring a trashed Shared workspace remains unshared until an explicit reshare', async () => {
  const { service, tables, workspaceId, ownerId } = lifecycleHarness();

  await service.deleteWorkspace(workspaceId, ownerId);
  assert.equal(tables.workspaces[0].status, 'trashed');
  assert.equal(tables.workspace_members.length, 3);
  assert.equal(tables.workspace_publication_links[0].status, 'detached');
  assert.ok(tables.workspaces[0].purgeAfter instanceof Date);

  await service.restoreWorkspace(workspaceId, ownerId);
  assert.equal(tables.workspaces[0].status, 'unshared');
  assert.equal(tables.workspaces[0].purgeAfter, null);
  assert.equal(tables.workspace_publication_links[0].status, 'detached');
});

test('restoring a workspace that was unshared before trash does not silently restore access', async () => {
  const { service, tables, workspaceId, ownerId, collaboratorId } = lifecycleHarness();

  await service.unshareWorkspace(workspaceId, ownerId);
  await service.deleteWorkspace(workspaceId, ownerId);
  await service.restoreWorkspace(workspaceId, ownerId);

  assert.equal(tables.workspaces[0].status, 'unshared');
  await assert.rejects(service.ensureMembership(workspaceId, collaboratorId), /no longer shared/);
});

test('a non-owner can leave direct access without affecting other grants', async () => {
  const { service, tables, workspaceId, collaboratorId } = lifecycleHarness();

  await service.leaveWorkspace(workspaceId, collaboratorId);
  assert.equal(tables.workspace_members.some((row) => row.userId === collaboratorId), false);
  assert.equal(tables.workspace_user_grants.some((row) => row.userId === collaboratorId), false);
  assert.equal(tables.workspace_members.length, 2);
});

test('team-managed access cannot be left by deleting only the direct membership', async () => {
  const { service, tables, workspaceId, collaboratorId } = lifecycleHarness();
  const teamId = '66666666-6666-4666-8666-666666666666';
  tables.workspaces[0].teamId = teamId;
  tables.group_members = [{ groupId: teamId, userId: collaboratorId }];

  await assert.rejects(
    service.leaveWorkspace(workspaceId, collaboratorId),
    /managed by your Team/,
  );
  assert.equal(tables.workspace_members.some((row) => row.userId === collaboratorId), true);
  assert.equal(tables.workspace_user_grants.some((row) => row.userId === collaboratorId), true);
});

test('ownership transfer promotes the target and demotes the former owner atomically', async () => {
  const { service, tables, workspaceId, ownerId, nextOwnerId } = lifecycleHarness();

  await service.transferWorkspaceOwnership(workspaceId, ownerId, nextOwnerId);
  assert.equal(tables.workspaces[0].ownerId, nextOwnerId);
  assert.equal(tables.workspace_members.find((row) => row.userId === nextOwnerId)?.role, 'owner');
  assert.equal(tables.workspace_members.find((row) => row.userId === ownerId)?.role, 'editor');
  assert.equal(tables.workspace_user_grants.find((row) => row.userId === nextOwnerId)?.role, 'publisher');
});
