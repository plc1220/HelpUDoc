import assert from 'node:assert/strict';
import test from 'node:test';

import { UserService, isUserInvited, isUserDeactivated } from '../src/services/userService';

type Row = Record<string, any>;

/**
 * In-memory Knex stand-in covering the operators the invite and claim paths use.
 * It accepts things Postgres would reject — notably it cannot enforce the partial
 * unique index the claim depends on — so it proves control flow and nothing about
 * storage. The live walkthrough covers the rest.
 */
class Query implements PromiseLike<Row[]> {
  private predicates: Array<(row: Row) => boolean> = [];
  private orderKey: ((row: Row) => number) | null = null;

  constructor(private readonly rows: Row[]) {}

  private add(predicate: (row: Row) => boolean): this {
    this.predicates.push(predicate);
    return this;
  }

  where(criteria: Row | string | ((builder: any) => void), value?: any): this {
    if (typeof criteria === 'function') {
      const branches: Array<(row: Row) => boolean> = [];
      const collector: any = {
        whereNull: (c: string) => { branches.push((row) => row[c] == null); return collector; },
        orWhere: (c: any, v?: any) => {
          branches.push(typeof c === 'string'
            ? (row) => row[c] === v
            : (row) => Object.entries(c).every(([k, val]) => row[k] === val));
          return collector;
        },
        orWhereNot: (c: Row) => {
          branches.push((row) => Object.entries(c).some(([k, val]) => row[k] !== val));
          return collector;
        },
      };
      criteria(collector);
      return this.add((row) => branches.some((b) => b(row)));
    }
    if (typeof criteria === 'string') return this.add((row) => row[criteria] === value);
    return this.add((row) => Object.entries(criteria).every(([k, v]) => row[k] === v));
  }

  andWhere(criteria: any, value?: any): this { return this.where(criteria, value); }
  andWhereNot(column: string, value: any): this {
    return this.add((row) => row[column] !== value);
  }

  /** Only the `lower(email) = ?` form the claim and invite paths use. */
  whereRaw(sql: string, bindings: any[]): this {
    if (!/lower\(email\)/.test(sql)) throw new Error(`Unsupported whereRaw: ${sql}`);
    const wanted = String(bindings[0]);
    return this.add((row) => String(row.email ?? '').toLowerCase() === wanted);
  }

  orderByRaw(sql: string): this {
    if (/status = 'invited'/.test(sql)) {
      this.orderKey = (row) => (row.status === 'invited' ? 0 : 1);
    }
    return this;
  }

  whereIn(column: string, values: any[]): this {
    return this.add((row) => values.includes(row[column]));
  }

  forUpdate(): this { return this; }
  orderBy(): this { return this; }
  select(): this { return this; }
  leftJoin(): this { return this; }
  join(): this { return this; }

  private matching(): Row[] {
    const rows = this.rows.filter((row) => this.predicates.every((p) => p(row)));
    return this.orderKey ? [...rows].sort((a, b) => this.orderKey!(a) - this.orderKey!(b)) : rows;
  }

  async first(): Promise<Row | undefined> { return this.matching()[0]; }

  /**
   * Knex allows `.update(...).returning('*')`, so the return value has to be
   * thenable *and* carry `returning`. Returning a bare array here made the claim
   * path look broken when only the fake was.
   */
  update(values: Row): any {
    const apply = () => {
      const matching = this.matching();
      matching.forEach((row) => Object.assign(row, values));
      return matching;
    };
    const builder: any = {
      returning: () => builder,
      then: (onfulfilled: any, onrejected: any) =>
        Promise.resolve().then(apply).then(onfulfilled, onrejected),
    };
    return builder;
  }

  async del(): Promise<number> {
    const doomed = new Set(this.matching());
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (doomed.has(this.rows[i])) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }

  insert(values: Row | Row[]): any {
    const list = Array.isArray(values) ? values : [values];
    let conflict: string[] = [];
    const builder: any = {
      // Knex accepts a single column name or an array; `ensureUser` uses the
      // string form and the invite paths use arrays.
      onConflict: (columns: string | string[]) => {
        conflict = Array.isArray(columns) ? columns : [columns];
        return builder;
      },
      ignore: () => builder,
      merge: () => builder,
      returning: () => builder,
      then: (onfulfilled: any, onrejected: any) => Promise.resolve().then(() => {
        const written: Row[] = [];
        for (const value of list) {
          const existing = conflict.length
            ? this.rows.find((row) => conflict.every((c) => row[c] === value[c]))
            : undefined;
          if (!existing) { this.rows.push({ ...value }); written.push(value); }
          else written.push(existing);
        }
        return written;
      }).then(onfulfilled, onrejected),
    };
    return builder;
  }

  then<T1 = Row[], T2 = never>(
    onfulfilled?: ((value: Row[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.matching()).then(onfulfilled, onrejected);
  }
}

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SALES = 'tttttttt-tttt-4ttt-8ttt-tttttttttttt';
const LEGAL = 'llllllll-llll-4lll-8lll-llllllllllll';

function harness(seedUsers: Row[] = []) {
  const tables: Record<string, Row[]> = {
    users: [
      { id: ADMIN, externalId: 'admin', email: 'admin@acme.com', displayName: 'Admin', isAdmin: true, isSystem: false, status: 'active' },
      ...seedUsers,
    ],
    groups: [{ id: SALES, name: 'Sales' }, { id: LEGAL, name: 'Legal' }],
    group_members: [],
    team_role_bindings: [],
    platform_role_bindings: [],
    audit_events: [],
  };
  const db = ((table: string) => new Query(tables[table] || (tables[table] = []))) as any;
  db.fn = { now: () => '2026-09-02T00:00:00.000Z' };
  db.raw = (sql: string) => sql;
  db.transaction = async (op: (tx: any) => Promise<unknown>) => op(db);

  const service = Object.create(UserService.prototype) as UserService;
  Object.assign(service, { db });
  return { service, tables };
}

test('registering a person creates their teams, lead role and admin flag before any login', async () => {
  const { service, tables } = harness();

  const results = await service.inviteUsers(ADMIN, {
    emails: ['Alice@Acme.com'],
    teamIds: [SALES, LEGAL],
    leadTeamIds: [SALES],
    isAdmin: true,
  });

  assert.equal(results[0].outcome, 'invited');
  const invited = tables.users.find((row) => row.email === 'alice@acme.com')!;
  assert.equal(invited.status, 'invited');
  // Normalized on the way in, so the claim can match on lower(email).
  assert.equal(invited.email, 'alice@acme.com');
  assert.equal(invited.externalId, 'invited:alice@acme.com');
  assert.equal(invited.isAdmin, true);
  assert.equal(invited.invitedByUserId, ADMIN);

  assert.equal(tables.group_members.filter((row) => row.userId === invited.id).length, 2);
  assert.equal(tables.team_role_bindings.length, 1);
  assert.equal(tables.team_role_bindings[0].teamId, SALES);
  assert.equal(tables.platform_role_bindings.length, 1);
  assert.equal(tables.audit_events[0].action, 'user.invited');
});

test('claiming keeps the same user id, so pre-assigned teams survive', async () => {
  // This is the assertion the whole design rests on: a merge would have to
  // rewrite every foreign key pointing at users.id, so the row is rewritten
  // in place instead.
  const { service, tables } = harness();
  await service.inviteUsers(ADMIN, { emails: ['alice@acme.com'], teamIds: [SALES], leadTeamIds: [SALES] });
  const invitedId = tables.users.find((row) => row.email === 'alice@acme.com')!.id;

  const claimed = await service.ensureUser({
    externalId: 'google-99887766',
    displayName: 'Alice Nguyen',
    email: 'alice@acme.com',
    emailVerified: true,
    oidcIssuer: 'https://accounts.google.com',
    oidcSubject: '99887766',
  });

  assert.equal(claimed.id, invitedId);
  assert.equal(claimed.externalId, 'google-99887766');
  assert.equal(claimed.status, 'active');
  assert.equal(claimed.displayName, 'Alice Nguyen');
  assert.ok(claimed.claimedAt);
  assert.equal(isUserInvited(claimed), false);

  // Exactly one row, and the memberships still point at it.
  assert.equal(tables.users.filter((row) => row.email === 'alice@acme.com').length, 1);
  assert.equal(tables.group_members.filter((row) => row.userId === invitedId).length, 1);
  assert.equal(tables.team_role_bindings.filter((row) => row.userId === invitedId).length, 1);
  assert.ok(tables.audit_events.some((row) => row.action === 'user.invite_claimed'));
});

test('a mixed-case stored address is still matched', async () => {
  const { service, tables } = harness([{
    id: 'inv-1', externalId: 'invited:bob@acme.com', email: 'BOB@Acme.com',
    displayName: 'bob', isAdmin: false, isSystem: false, status: 'invited',
  }]);

  const claimed = await service.ensureUser({
    externalId: 'google-1', displayName: 'Bob', email: 'bob@acme.com',
    emailVerified: true, oidcIssuer: 'https://accounts.google.com', oidcSubject: '1',
  });

  assert.equal(claimed.id, 'inv-1');
  assert.equal(tables.users.length, 2);
});

test('an unverified email cannot claim a registration', async () => {
  // Otherwise anyone able to assert an invited address would inherit its teams
  // and admin flag.
  const { service, tables } = harness();
  await service.inviteUsers(ADMIN, { emails: ['alice@acme.com'], teamIds: [SALES], isAdmin: true });
  const invitedId = tables.users.find((row) => row.email === 'alice@acme.com')!.id;

  const created = await service.ensureUser({
    externalId: 'google-attacker', displayName: 'Not Alice', email: 'alice@acme.com',
    emailVerified: false, oidcIssuer: 'https://accounts.google.com', oidcSubject: 'attacker',
  });

  assert.notEqual(created.id, invitedId);
  assert.equal(created.isAdmin, false);
  // The registration is untouched and still claimable by its real owner.
  assert.equal(tables.users.find((row) => row.id === invitedId)!.status, 'invited');
});

test('an active row with the same address is never claimed', async () => {
  // The dev database has eight active rows sharing one address, courtesy of
  // DEFAULT_USER_EMAIL. None of them may be taken over by a claim.
  const { service, tables } = harness([{
    id: 'active-1', externalId: 'someone-else', email: 'shared@local.com',
    displayName: 'Someone', isAdmin: false, isSystem: false, status: 'active',
  }]);

  const created = await service.ensureUser({
    externalId: 'google-2', displayName: 'New Person', email: 'shared@local.com',
    emailVerified: true, oidcIssuer: 'https://accounts.google.com', oidcSubject: '2',
  });

  assert.notEqual(created.id, 'active-1');
  assert.equal(tables.users.find((row) => row.id === 'active-1')!.externalId, 'someone-else');
});

test('re-registering a known address reports it instead of duplicating', async () => {
  const { service, tables } = harness([{
    id: 'active-1', externalId: 'alice', email: 'alice@acme.com',
    displayName: 'Alice', isAdmin: false, isSystem: false, status: 'active',
  }]);

  const results = await service.inviteUsers(ADMIN, { emails: ['alice@acme.com'], teamIds: [SALES] });

  assert.equal(results[0].outcome, 'already_active');
  assert.equal(tables.users.length, 2);
  // Nothing was granted: reporting the clash must not quietly widen access.
  assert.equal(tables.group_members.length, 0);
});

test('a bad address fails alone and the rest of the batch still applies', async () => {
  const { service, tables } = harness();

  const results = await service.inviteUsers(ADMIN, {
    emails: ['good@acme.com', 'not-an-email', '', '   ', 'second@acme.com'],
    teamIds: [SALES],
  });

  assert.deepEqual(results.map((r) => r.outcome), ['invited', 'invalid', 'invalid', 'invalid', 'invited']);
  assert.equal(tables.users.filter((row) => row.status === 'invited').length, 2);
});

test('a lead role is dropped for a team the person is not being added to', async () => {
  const { service, tables } = harness();

  await service.inviteUsers(ADMIN, { emails: ['alice@acme.com'], teamIds: [SALES], leadTeamIds: [LEGAL] });

  assert.equal(tables.team_role_bindings.length, 0);
});

test('revoking removes an unclaimed registration but refuses a claimed account', async () => {
  const { service, tables } = harness();
  await service.inviteUsers(ADMIN, { emails: ['alice@acme.com'], teamIds: [SALES] });
  const invitedId = tables.users.find((row) => row.email === 'alice@acme.com')!.id;

  await service.revokeInvitation(invitedId, ADMIN);
  assert.equal(tables.users.some((row) => row.id === invitedId), false);
  assert.ok(tables.audit_events.some((row) => row.action === 'user.invite_revoked'));

  await assert.rejects(service.revokeInvitation(ADMIN, ADMIN), /already been claimed/);
});

test('invited is not deactivated — an invited row must be able to sign in', async () => {
  assert.equal(isUserDeactivated({ status: 'invited' }), false);
  assert.equal(isUserInvited({ status: 'invited' }), true);
  assert.equal(isUserInvited({ status: 'active' }), false);
  assert.equal(isUserInvited({}), false);
});

test('invite-only admits existing and registered identities, refuses strangers', async () => {
  const { service } = harness([{
    id: 'inv-1', externalId: 'invited:alice@acme.com', email: 'alice@acme.com',
    displayName: 'alice', isAdmin: false, isSystem: false, status: 'invited',
  }]);

  assert.equal(await service.isAdmissibleSignIn({ externalId: 'admin' }), true);
  assert.equal(
    await service.isAdmissibleSignIn({ externalId: 'google-x', email: 'alice@acme.com' }),
    true,
  );
  assert.equal(
    await service.isAdmissibleSignIn({ externalId: 'google-y', email: 'stranger@acme.com' }),
    false,
  );
});
