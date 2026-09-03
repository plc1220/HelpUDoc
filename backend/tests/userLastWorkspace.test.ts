import assert from 'node:assert/strict';
import test from 'node:test';

import { UserService } from '../src/services/userService';

type Row = Record<string, any>;

/**
 * Minimal in-memory Knex stand-in for the two column accessors under test. As with
 * the other fakes in this suite, it accepts values Postgres would reject, so it
 * proves control flow and nothing about storage — the column itself still has to be
 * exercised against a real database (the retrofit path is exactly where a fresh and
 * a migrated database can diverge).
 */
class Query implements PromiseLike<Row[]> {
  private predicates: Array<(row: Row) => boolean> = [];

  constructor(private readonly rows: Row[]) {}

  where(criteria: Row): this {
    this.predicates.push((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
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

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.matching()).then(onfulfilled, onrejected);
  }
}

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = '2026-09-02T00:00:00.000Z';

function harness(users: Row[]) {
  const tables: Record<string, Row[]> = { users };
  const db = ((table: string) => new Query(tables[table] || (tables[table] = []))) as any;
  db.fn = { now: () => NOW };

  const service = Object.create(UserService.prototype) as UserService;
  Object.assign(service, { db });
  return { service, tables };
}

test('returns null when the row predates the column', async () => {
  // A pre-migration row, and every hand-built fake in this suite, simply omits the
  // key. That must read as "no preference", never as a crash.
  const { service } = harness([{ id: USER, externalId: 'user', displayName: 'User' }]);
  assert.equal(await service.getLastWorkspaceId(USER), null);
});

test('returns null when the column is explicitly null', async () => {
  const { service } = harness([{ id: USER, lastWorkspaceId: null }]);
  assert.equal(await service.getLastWorkspaceId(USER), null);
});

test('returns the stored workspace id', async () => {
  const { service } = harness([{ id: USER, lastWorkspaceId: WORKSPACE }]);
  assert.equal(await service.getLastWorkspaceId(USER), WORKSPACE);
});

test('reads only the requested user', async () => {
  const { service } = harness([
    { id: OTHER_USER, lastWorkspaceId: 'someone-elses-workspace' },
    { id: USER, lastWorkspaceId: WORKSPACE },
  ]);
  assert.equal(await service.getLastWorkspaceId(USER), WORKSPACE);
});

test('writing stores the id and stamps the opened timestamp', async () => {
  const { service, tables } = harness([{ id: USER, lastWorkspaceId: null }]);

  await service.setLastWorkspaceId(USER, WORKSPACE);

  assert.equal(tables.users[0].lastWorkspaceId, WORKSPACE);
  assert.equal(tables.users[0].lastWorkspaceOpenedAt, NOW);
});

test('writing does not bump updatedAt', async () => {
  // This fires on every workspace open. Bumping `updatedAt` would destroy its
  // meaning as a profile-change timestamp.
  const { service, tables } = harness([
    { id: USER, lastWorkspaceId: null, updatedAt: '2026-01-01T00:00:00.000Z' },
  ]);

  await service.setLastWorkspaceId(USER, WORKSPACE);

  assert.equal(tables.users[0].updatedAt, '2026-01-01T00:00:00.000Z');
});

test('clearing nulls both the id and the timestamp', async () => {
  const { service, tables } = harness([
    { id: USER, lastWorkspaceId: WORKSPACE, lastWorkspaceOpenedAt: NOW },
  ]);

  await service.setLastWorkspaceId(USER, null);

  assert.equal(tables.users[0].lastWorkspaceId, null);
  assert.equal(tables.users[0].lastWorkspaceOpenedAt, null);
});

test('writing touches only the requested user', async () => {
  const { service, tables } = harness([
    { id: OTHER_USER, lastWorkspaceId: null },
    { id: USER, lastWorkspaceId: null },
  ]);

  await service.setLastWorkspaceId(USER, WORKSPACE);

  assert.equal(tables.users[0].lastWorkspaceId, null);
  assert.equal(tables.users[1].lastWorkspaceId, WORKSPACE);
});
