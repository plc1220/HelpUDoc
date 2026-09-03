import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveActivityScope } from '../src/services/activityService';

type Row = Record<string, any>;

/**
 * Fake covering only the three reads `resolveActivityScope` performs. As with
 * the other fakes here it proves control flow and nothing about storage — the
 * scoping itself was exercised against a real database with real role rows.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const build = (name: string) => {
    // Knex table names arrive aliased, e.g. 'team_role_bindings as role'.
    const rows = tables[name.split(' as ')[0]] || [];
    let preds: Array<(r: Row) => boolean> = [];
    const q: any = {
      where(criteria: Row) {
        preds.push((r) => Object.entries(criteria).every(([k, v]) => r[k.split('.').pop()!] === v));
        return q;
      },
      whereIn(col: string, values: any[]) {
        const key = col.split('.').pop()!;
        preds.push((r) => values.includes(r[key]));
        return q;
      },
      join(other: string, cb: any) {
        // Only used for the team_role_bindings -> group_members join: keep rows
        // whose (teamId, userId) pair has a backing membership.
        const members = tables[other.split(' as ')[0]] || [];
        preds.push((r) => members.some((m) => m.groupId === r.teamId && m.userId === r.userId));
        void cb;
        return q;
      },
      distinct() { return q; },
      select() { return q; },
      first() { return Promise.resolve(rows.filter((r) => preds.every((p) => p(r)))[0]); },
      then(onF: any, onR: any) {
        return Promise.resolve(rows.filter((r) => preds.every((p) => p(r)))).then(onF, onR);
      },
    };
    return q;
  };
  return ((name: string) => build(name)) as any;
}

const ADMIN = 'user-admin';
const LEAD = 'user-lead';
const MEMBER = 'user-member';
const TEAM = 'team-1';

test('a platform admin gets platform scope', async () => {
  const db = fakeDb({ users: [{ id: ADMIN, isAdmin: true }], platform_role_bindings: [] });
  assert.deepEqual(await resolveActivityScope(db, ADMIN), { kind: 'platform' });
});

test('a platform_role_bindings row also counts as admin', async () => {
  const db = fakeDb({
    users: [{ id: ADMIN, isAdmin: false }],
    platform_role_bindings: [{ userId: ADMIN, role: 'platform_admin' }],
  });
  assert.deepEqual(await resolveActivityScope(db, ADMIN), { kind: 'platform' });
});

test('a plain member gets no scope at all', async () => {
  // Null, not an empty list: the route turns this into a 403, because an empty
  // feed would read as "nothing happened" rather than "not for you".
  const db = fakeDb({
    users: [{ id: MEMBER, isAdmin: false }],
    platform_role_bindings: [],
    team_role_bindings: [],
    group_members: [],
  });
  assert.equal(await resolveActivityScope(db, MEMBER), null);
});

test('a lead is scoped to the workspaces their team owns', async () => {
  const db = fakeDb({
    users: [{ id: LEAD, isAdmin: false }],
    platform_role_bindings: [],
    team_role_bindings: [{ teamId: TEAM, userId: LEAD, role: 'lead' }],
    group_members: [{ groupId: TEAM, userId: LEAD }],
    workspaces: [
      { id: 'ws-team', teamId: TEAM },
      { id: 'ws-other', teamId: 'team-2' },
      { id: 'ws-private', teamId: null },
    ],
  });
  const scope = await resolveActivityScope(db, LEAD);
  assert.deepEqual(scope, { kind: 'teams', teamIds: [TEAM], workspaceIds: ['ws-team'] });
});

test('a lead whose team owns no workspace gets an empty set, not a wildcard', async () => {
  // The dangerous case: an empty id list must mean "nothing", never "everything".
  const db = fakeDb({
    users: [{ id: LEAD, isAdmin: false }],
    platform_role_bindings: [],
    team_role_bindings: [{ teamId: TEAM, userId: LEAD, role: 'lead' }],
    group_members: [{ groupId: TEAM, userId: LEAD }],
    workspaces: [{ id: 'ws-other', teamId: 'team-2' }],
  });
  const scope = await resolveActivityScope(db, LEAD);
  assert.deepEqual(scope, { kind: 'teams', teamIds: [TEAM], workspaceIds: [] });
});

test('a lead binding without backing membership is not a lead', async () => {
  const db = fakeDb({
    users: [{ id: LEAD, isAdmin: false }],
    platform_role_bindings: [],
    team_role_bindings: [{ teamId: TEAM, userId: LEAD, role: 'lead' }],
    group_members: [],
  });
  assert.equal(await resolveActivityScope(db, LEAD), null);
});
