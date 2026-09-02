import assert from 'node:assert/strict';
import test from 'node:test';

import { UserService, isUserDeactivated } from '../src/services/userService';

type Row = Record<string, any>;

/**
 * Minimal in-memory Knex stand-in covering the operators the deactivation paths
 * use. These fakes accept things Postgres would reject, so they prove control
 * flow and nothing about storage — the archive/handover behaviour still has to
 * be exercised against a real database.
 */
class Query implements PromiseLike<Row[]> {
  private predicates: Array<(row: Row) => boolean> = [];

  constructor(private readonly rows: Row[]) {}

  private add(predicate: (row: Row) => boolean): this {
    this.predicates.push(predicate);
    return this;
  }

  where(criteria: Row | string | ((builder: Query) => void), value?: any): this {
    if (typeof criteria === 'function') {
      // A grouped `where(builder => …)`: the callbacks in this codebase are all
      // OR-groups, so collect their branches and require at least one match.
      const branches: Array<(row: Row) => boolean> = [];
      const collector: any = {
        whereNull: (column: string) => { branches.push((row) => row[column] == null); return collector; },
        orWhereNot: (criteriaObject: Row) => {
          branches.push((row) => Object.entries(criteriaObject).some(([key, val]) => row[key] !== val));
          return collector;
        },
        where: (column: string, val: any) => { branches.push((row) => row[column] === val); return collector; },
        orWhere: (column: string, val: any) => { branches.push((row) => row[column] === val); return collector; },
      };
      criteria(collector);
      return this.add((row) => branches.some((branch) => branch(row)));
    }
    if (typeof criteria === 'string') {
      return this.add((row) => row[criteria] === value);
    }
    return this.add((row) => Object.entries(criteria).every(([key, val]) => row[key] === val));
  }

  andWhere(criteria: Row | string | ((builder: Query) => void), value?: any): this {
    return this.where(criteria as any, value);
  }

  whereNot(criteria: Row): this {
    return this.add((row) => Object.entries(criteria).some(([key, val]) => row[key] !== val));
  }

  whereIn(column: string, values: any[]): this {
    return this.add((row) => values.includes(row[column]));
  }

  whereNotIn(column: string, values: any[]): this {
    return this.add((row) => !values.includes(row[column]));
  }

  forUpdate(): this { return this; }
  orderBy(): this { return this; }
  select(): this { return this; }

  private matching(): Row[] {
    return this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
  }

  async first(): Promise<Row | undefined> {
    return this.matching()[0];
  }

  async count(): Promise<any> {
    return { count: String(this.matching().length), first: undefined };
  }

  async update(values: Row): Promise<number> {
    const matching = this.matching();
    matching.forEach((row) => Object.assign(row, values));
    return matching.length;
  }

  insert(values: Row | Row[]): any {
    const list = Array.isArray(values) ? values : [values];
    const push = () => {
      for (const value of list) {
        const existing = this.conflictColumns.length
          ? this.rows.find((row) => this.conflictColumns.every((column) => row[column] === value[column]))
          : undefined;
        if (existing && this.mergeValues) Object.assign(existing, this.mergeValues);
        else if (!existing) this.rows.push({ ...value });
      }
      return list;
    };
    const builder: any = {
      onConflict: (columns: string[]) => { this.conflictColumns = columns; return builder; },
      merge: (mergeValues: Row) => { this.mergeValues = mergeValues; return builder; },
      ignore: () => builder,
      then: (onfulfilled: any, onrejected: any) =>
        Promise.resolve().then(push).then(onfulfilled, onrejected),
    };
    return builder;
  }

  private conflictColumns: string[] = [];
  private mergeValues: Row | null = null;

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.matching()).then(onfulfilled, onrejected);
  }
}

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HEIR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRIVATE_WS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHARED_WS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function harness(overrides: { tables?: Record<string, Row[]> } = {}) {
  const timestamps = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const tables: Record<string, Row[]> = {
    users: [
      { id: ADMIN, externalId: 'admin', displayName: 'Admin', isAdmin: true, isSystem: false, status: 'active' },
      { id: TARGET, externalId: 'target', displayName: 'Target', isAdmin: false, isSystem: false, status: 'active' },
      { id: HEIR, externalId: 'heir', displayName: 'Heir', isAdmin: false, isSystem: false, status: 'active' },
    ],
    workspaces: [
      {
        id: PRIVATE_WS, ownerId: TARGET, name: 'Draft notes', slug: 'draft-notes',
        visibility: 'private', workspaceType: 'private', status: 'active', isSystem: false,
        contentRevision: 1, ...timestamps,
      },
      {
        id: SHARED_WS, ownerId: TARGET, name: 'Team pack', slug: 'team-pack',
        visibility: 'team', workspaceType: 'team', editingPolicy: 'direct', status: 'active',
        isSystem: false, contentRevision: 1, ...timestamps,
      },
    ],
    workspace_members: [
      { workspaceId: SHARED_WS, userId: TARGET, role: 'owner', canEdit: true, ...timestamps },
      { workspaceId: SHARED_WS, userId: HEIR, role: 'editor', canEdit: true, ...timestamps },
    ],
    workspace_user_grants: [],
    workspace_schedules: [
      { id: 'sched-1', workspaceId: PRIVATE_WS, createdBy: TARGET, status: 'active' },
      { id: 'sched-2', workspaceId: SHARED_WS, createdBy: HEIR, status: 'active' },
    ],
    audit_events: [],
    ...(overrides.tables || {}),
  };

  const db = ((table: string) => new Query(tables[table] || (tables[table] = []))) as any;
  db.fn = { now: () => '2026-09-02T00:00:00.000Z' };
  db.transaction = async (operation: (tx: any) => Promise<unknown>) => operation(db);

  const service = Object.create(UserService.prototype) as UserService;
  Object.assign(service, { db });
  return { service, tables };
}

test('deactivation archives private workspaces and hands over shared ones', async () => {
  const { service, tables } = harness();

  const result = await service.deactivateUser(TARGET, ADMIN, {
    reason: 'Left the company',
    sharedWorkspaceOwners: [{ workspaceId: SHARED_WS, newOwnerUserId: HEIR }],
  });

  assert.deepEqual(result.archivedWorkspaceIds, [PRIVATE_WS]);
  assert.deepEqual(result.transferredWorkspaceIds, [SHARED_WS]);

  const privateWorkspace = tables.workspaces.find((row) => row.id === PRIVATE_WS)!;
  assert.equal(privateWorkspace.status, 'trashed');
  // Stamped so reactivation restores this and not something the owner deleted.
  assert.equal(privateWorkspace.trashReason, 'owner_deactivated');
  assert.ok(privateWorkspace.purgeAfter instanceof Date);

  // The shared workspace has a live owner immediately — collaborators are never
  // left waiting out somebody else's suspension.
  const sharedWorkspace = tables.workspaces.find((row) => row.id === SHARED_WS)!;
  assert.equal(sharedWorkspace.ownerId, HEIR);
  assert.equal(sharedWorkspace.status, 'active');

  const targetUser = tables.users.find((row) => row.id === TARGET)!;
  assert.equal(targetUser.status, 'deactivated');
  assert.equal(targetUser.deactivationReason, 'Left the company');
  assert.equal(targetUser.deactivatedByUserId, ADMIN);

  assert.equal(tables.workspace_schedules.find((row) => row.id === 'sched-1')!.status, 'paused');
  // Somebody else's schedule in the same workspace is untouched.
  assert.equal(tables.workspace_schedules.find((row) => row.id === 'sched-2')!.status, 'active');

  const actions = tables.audit_events.map((row) => row.action).sort();
  assert.deepEqual(actions, [
    'user.deactivated',
    'workspace.archived_for_deactivation',
    'workspace.ownership_transferred',
  ]);
});

test('deactivation refuses to strand a shared workspace without an owner', async () => {
  const { service, tables } = harness();

  await assert.rejects(
    service.deactivateUser(TARGET, ADMIN, { reason: 'No handover given' }),
    /needs a new owner/,
  );

  // Nothing partially applied: the archive and the suspension share a transaction.
  assert.equal(tables.users.find((row) => row.id === TARGET)!.status, 'active');
});

test('an admin cannot deactivate themselves', async () => {
  const { service } = harness();
  await assert.rejects(
    service.deactivateUser(ADMIN, ADMIN, { reason: 'oops' }),
    /cannot deactivate your own account/,
  );
});

test('the last remaining platform admin cannot be deactivated', async () => {
  const { service } = harness({
    tables: {
      users: [
        { id: ADMIN, externalId: 'admin', displayName: 'Admin', isAdmin: true, isSystem: false, status: 'active' },
        { id: TARGET, externalId: 'other', displayName: 'Other admin', isAdmin: true, isSystem: false, status: 'active' },
      ],
      workspaces: [],
    },
  });

  // Both are admins, so removing one leaves one — allowed. Demote the actor and
  // the target becomes the last one standing.
  await assert.rejects(
    (async () => {
      const { service: soleAdminService } = harness({
        tables: {
          users: [
            { id: ADMIN, externalId: 'admin', displayName: 'Admin', isAdmin: false, isSystem: false, status: 'active' },
            { id: TARGET, externalId: 'other', displayName: 'Only admin', isAdmin: true, isSystem: false, status: 'active' },
          ],
          workspaces: [],
        },
      });
      await soleAdminService.deactivateUser(TARGET, ADMIN, { reason: 'test' });
    })(),
    /final active Platform Admin/,
  );

  await service.deactivateUser(TARGET, ADMIN, { reason: 'still one admin left' });
});

test('a blank reason is stored as null rather than an empty string', async () => {
  for (const reason of ['', '   ']) {
    const { service, tables } = harness();
    await service.deactivateUser(TARGET, ADMIN, {
      reason,
      sharedWorkspaceOwners: [{ workspaceId: SHARED_WS, newOwnerUserId: HEIR }],
    });
    assert.equal(
      tables.users.find((row) => row.id === TARGET)!.deactivationReason,
      null,
      `reason ${JSON.stringify(reason)} should normalize to null`,
    );
  }
});

test('deactivating an already-deactivated user is a no-op, not an error', async () => {
  const { service, tables } = harness();
  tables.users.find((row) => row.id === TARGET)!.status = 'deactivated';

  const result = await service.deactivateUser(TARGET, ADMIN, { reason: 'again' });
  assert.deepEqual(result.archivedWorkspaceIds, []);
  assert.equal(tables.workspaces.find((row) => row.id === PRIVATE_WS)!.status, 'active');
});

test('reactivation restores the archive it caused and leaves an owner delete alone', async () => {
  const { service, tables } = harness();
  await service.deactivateUser(TARGET, ADMIN, {
    reason: 'temporary',
    sharedWorkspaceOwners: [{ workspaceId: SHARED_WS, newOwnerUserId: HEIR }],
  });

  // A workspace the user themselves threw away before being suspended.
  tables.workspaces.push({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ownerId: TARGET,
    name: 'Deleted by owner',
    status: 'trashed',
    trashReason: 'user',
    visibility: 'private',
    workspaceType: 'private',
    isSystem: false,
  });

  const result = await service.reactivateUser(TARGET, ADMIN, {});

  assert.deepEqual(result.restoredWorkspaceIds, [PRIVATE_WS]);
  assert.equal(tables.workspaces.find((row) => row.id === PRIVATE_WS)!.status, 'active');
  assert.equal(tables.workspaces.find((row) => row.id === PRIVATE_WS)!.trashReason, null);
  // Not resurrected: the owner meant to delete this one.
  assert.equal(
    tables.workspaces.find((row) => row.id === 'ffffffff-ffff-4fff-8fff-ffffffffffff')!.status,
    'trashed',
  );

  assert.equal(tables.users.find((row) => row.id === TARGET)!.status, 'active');
  // Ownership stays where it went; somebody has been working there since.
  assert.equal(tables.workspaces.find((row) => row.id === SHARED_WS)!.ownerId, HEIR);
  // Automation restarts because a person decided to, not as a side effect.
  assert.equal(tables.workspace_schedules.find((row) => row.id === 'sched-1')!.status, 'paused');
});

test('isUserDeactivated treats a missing status as active', () => {
  // Rows written before the column existed, and every hand-built test fake,
  // omit it. Reading the column directly would lock those users out.
  assert.equal(isUserDeactivated({}), false);
  assert.equal(isUserDeactivated({ status: undefined }), false);
  assert.equal(isUserDeactivated(null), false);
  assert.equal(isUserDeactivated({ status: 'active' }), false);
  assert.equal(isUserDeactivated({ status: 'deactivated' }), true);
});
