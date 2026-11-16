import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import knex, { type Knex } from 'knex';
import { config } from 'dotenv';
import { CalendarProposalService } from '../src/services/calendarProposalService';
import { ensureCalendarSchema } from '../src/services/calendarSchema';
import { CalendarError, eventRef, sourceKey } from '../src/services/calendarModel';
import type { CalendarService } from '../src/services/calendarService';
import express from 'express';
import calendarRoutes from '../src/api/calendar';
import calendarProposalRoutes from '../src/api/calendarProposals';
import internalAgentRoutes from '../src/api/internalAgent';
import { signAgentContextToken } from '../src/services/agentToken';

const enabled = process.env.CALENDAR_INTEGRATION === '1';
const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const source = sourceKey('calendar:fixture', 'primary'), ref = eventRef(source, 'selected');
const meeting = { id: ref, kind: 'MEETING', title: 'Selected meeting', start: '2026-11-07T01:00:00Z', end: '2026-11-07T02:00:00Z', calendar_id: source, etag: '"original"', capabilities: { can_edit: true, can_delete: true } };
let db: Knex, admin: Knex, service: CalendarProposalService;
let allowed = true, membership = true, missing = false, editable = true;
let writes: unknown[][] = [];
const receipts = new Map<string, unknown>();
const calendar = {
  authorizeSource: async () => { await db.raw('SELECT 1'); if (!allowed || !editable) throw new CalendarError(403, 'PERMISSION_DENIED', 'Revoked or read-only'); return { can_edit: true }; },
  event: async () => { await db.raw('SELECT 1'); if (!allowed) throw new CalendarError(403, 'PERMISSION_DENIED', 'Revoked'); if (missing) throw new CalendarError(404, 'NOT_FOUND', 'Gone'); return editable ? meeting : { ...meeting, title: 'Busy', description: undefined, capabilities: { can_edit: false, can_delete: false } }; },
  mutate: async (...args: unknown[]) => {
    await db.raw('SELECT 1'); const key = String(args[5]); if (receipts.has(key)) return receipts.get(key);
    if (args[1] !== 'POST' && args[4] !== meeting.etag) throw new CalendarError(409, 'CALENDAR_CONFLICT', 'Changed');
    writes.push(args); const result = args[1] === 'DELETE' ? { deleted: true } : { ...meeting, etag: '"saved"' };
    if (args[1] === 'DELETE') missing = true; receipts.set(key, result); return result;
  },
} as unknown as CalendarService;
const schema = `calendar_proposal_test_${randomUUID().replaceAll('-', '')}`;
before(async () => {
  if (!enabled) return;
  config({ path: '../env/local/dev.env', quiet: true });
  admin = knex({ client: 'pg', connection: { host: '127.0.0.1', port: 5432, database: process.env.POSTGRES_DB || 'helpudoc', user: process.env.POSTGRES_USER || 'helpudoc', password: process.env.POSTGRES_PASSWORD || 'helpudoc' } });
  await admin.raw(`CREATE SCHEMA ${schema}`);
  db = knex({ client: 'pg', connection: admin.client.config.connection, searchPath: [schema], pool: { min: 0, max: 1 }, acquireConnectionTimeout: 1000 });
  await db.schema.createTable('users', table => table.uuid('id').primary()); await db('users').insert([{ id: user }, { id: other }]);
  await ensureCalendarSchema(db);
  service = new CalendarProposalService(db, calendar, { ensureMembership: async () => { if (!membership) throw new CalendarError(403, 'PERMISSION_DENIED', 'Workspace revoked'); } } as never);
});
beforeEach(async () => { if (!enabled) return; await db('calendar_proposals').del(); await db('calendar_audit').del(); allowed = membership = editable = true; missing = false; writes = []; receipts.clear(); });
after(async () => { if (!db) return; await db.destroy(); await admin.raw(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });

test('agent proposals are immutable, idempotent and require an explicit reviewed commit', { skip: !enabled }, async () => {
  const proposal = await service.propose(user, 'workspace', ref, 'PATCH', { title: 'Proposed title' }, 'stable-action-key');
  assert.equal(writes.length, 0); assert.equal(proposal.status, 'PENDING');
  assert.equal((await service.propose(user, 'workspace', ref, 'PATCH', { title: 'Proposed title' }, 'stable-action-key')).id, proposal.id);
  await assert.rejects(service.propose(user, 'workspace', ref, 'PATCH', { title: 'Different' }, 'stable-action-key'), (e: unknown) => e instanceof CalendarError && e.code === 'IDEMPOTENCY_CONFLICT');
  await service.commit(user, proposal.id, { title: 'Human reviewed title' }, '"original"');
  await service.commit(user, proposal.id, { title: 'Human reviewed title' }, '"original"');
  assert.equal(writes.length, 1); assert.equal((writes[0][3] as { title: string }).title, 'Human reviewed title');
  await assert.rejects(service.commit(user, proposal.id, { title: 'Different action' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
  assert.equal((await service.get(user, proposal.id)).status, 'APPLIED');
  const audit = await db('calendar_audit').whereRaw("data->>'action' = 'approve_and_apply'").first();
  assert.equal(audit.data.actor_kind, 'AGENT'); assert.equal(audit.data.approved_by_user_id, user);
});

test('proposals recheck current identity, workspace membership and Google rights before disclosure or application', { skip: !enabled }, async () => {
  const proposal = await service.propose(user, 'workspace', ref, 'PATCH', { title: 'Proposal' }, 'access-action-key');
  await assert.rejects(service.get(other, proposal.id), (e: unknown) => e instanceof CalendarError && e.status === 404);
  allowed = false;
  await assert.rejects(service.get(user, proposal.id), (e: unknown) => e instanceof CalendarError && e.status === 403);
  await assert.rejects(service.commit(user, proposal.id, { title: 'Proposal' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.status === 403);
  allowed = true; membership = false;
  await assert.rejects(service.commit(user, proposal.id, { title: 'Proposal' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.status === 403);
  assert.equal(writes.length, 0);
  membership = true; editable = false;
  await assert.rejects(service.get(user, proposal.id), (e: unknown) => e instanceof CalendarError && e.status === 403);
});

test('rejected or expired proposals cannot write; scope and provider ETag remain conditional', { skip: !enabled }, async () => {
  const proposal = await service.propose(user, 'workspace', ref, 'DELETE', {}, 'delete-action-key');
  await assert.rejects(service.commit(user, proposal.id, { scope: 'series' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'POLICY_DENIED');
  await assert.rejects(service.commit(user, proposal.id, {}, '"stale"'), (e: unknown) => e instanceof CalendarError && e.code === 'CALENDAR_CONFLICT');
  writes = []; await service.reject(user, proposal.id);
  await assert.rejects(service.commit(user, proposal.id, {}, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'POLICY_DENIED');
  const expired = await service.propose(user, 'workspace', ref, 'PATCH', { title: 'Expires' }, 'expired-action-key');
  await db('calendar_proposals').where({ id: expired.id }).update({ data: JSON.stringify({ ...expired, expires_at: '2020-01-01T00:00:00Z' }) });
  await assert.rejects(service.commit(user, expired.id, {}, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'PROPOSAL_EXPIRED');
  assert.equal(writes.length, 0);
});

test('completed deletion remains idempotent without disclosing deleted event content', { skip: !enabled }, async () => {
  const proposal = await service.propose(user, 'workspace', ref, 'DELETE', {}, 'complete-delete-key');
  await service.commit(user, proposal.id, {}, '"original"'); missing = true;
  assert.deepEqual(await service.commit(user, proposal.id, {}, '"original"'), { deleted: true });
  assert.equal((await service.get(user, proposal.id)).before, undefined); assert.equal(writes.length, 1);
  await assert.rejects(service.reject(user, proposal.id), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
});

test('a provider-confirmed deletion can recover after local proposal finalization fails, with a one-connection pool', { skip: !enabled }, async () => {
  const proposal = await service.propose(user, 'workspace', ref, 'DELETE', {}, 'finalization-retry-key');
  await db.raw(`CREATE FUNCTION fail_calendar_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'status' = 'APPLIED' THEN RAISE EXCEPTION 'Simulated finalization failure'; END IF; RETURN NEW; END $$`);
  await db.raw('CREATE TRIGGER fail_calendar_finalization BEFORE UPDATE ON calendar_proposals FOR EACH ROW EXECUTE FUNCTION fail_calendar_finalization()');
  try {
    await assert.rejects(service.commit(user, proposal.id, {}, '"original"'), /Simulated finalization failure/);
    assert.equal(writes.length, 1); assert.equal(missing, true);
    const saved = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
    assert.equal(saved.status, 'APPLYING'); assert.equal(saved.attempt_lease_id, undefined); assert.equal(saved.attempt_lease_until, undefined);
    await assert.rejects(service.commit(user, proposal.id, { send_updates: 'none' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
  } finally { await db.raw('DROP TRIGGER fail_calendar_finalization ON calendar_proposals'); await db.raw('DROP FUNCTION fail_calendar_finalization()'); }
  await db('calendar_proposals').where({ id: proposal.id }).update({ data: db.raw("jsonb_set(data, '{expires_at}', '\"2020-01-01T00:00:00Z\"'::jsonb)") });
  assert.deepEqual(await service.commit(user, proposal.id, {}, '"original"'), { deleted: true });
  assert.equal(writes.length, 1); assert.equal((await db('calendar_proposals').where({ id: proposal.id }).first()).data.status, 'APPLIED');
});

test('an active proposal attempt blocks duplicate execution and changed approval until its provider call settles', { skip: !enabled, timeout: 5000 }, async () => {
  let entered!: () => void, release!: () => void, providerCalls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controlled = {
    ...calendar,
    mutate: async (...args: unknown[]) => {
      await db.raw('SELECT 1'); providerCalls++;
      if (providerCalls === 1) { entered(); await gate; throw new CalendarError(409, 'CALENDAR_CONFLICT', 'Provider rejected this ETag'); }
      return { ...meeting, title: (args[3] as { title: string }).title, etag: '"saved"' };
    },
  } as unknown as CalendarService;
  const proposals = new CalendarProposalService(db, controlled, { ensureMembership: async () => undefined } as never);
  const proposal = await proposals.propose(user, 'workspace', ref, 'PATCH', { title: 'First review' }, 'controlled-active-attempt');
  const first = proposals.commit(user, proposal.id, { title: 'First review' }, '"original"');
  const firstRejected = assert.rejects(first, (e: unknown) => e instanceof CalendarError && e.code === 'CALENDAR_CONFLICT');
  await started;
  try {
    const applying = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
    assert.equal(applying.status, 'APPLYING'); assert.ok(applying.attempt_lease_id);
    const remaining = Date.parse(applying.attempt_lease_until) - Date.now(); assert.ok(remaining > 0 && remaining <= 120000);
    await assert.rejects(proposals.commit(user, proposal.id, { title: 'First review' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.status === 423 && e.code === 'ACTION_IN_PROGRESS');
    await assert.rejects(proposals.commit(user, proposal.id, { title: 'Different review' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
    await assert.rejects(proposals.reject(user, proposal.id), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
    assert.equal(providerCalls, 1);
    assert.equal((await db('calendar_proposals').where({ id: proposal.id }).first()).data.attempt_lease_id, applying.attempt_lease_id);
  } finally { release(); await firstRejected; }
  const pending = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
  assert.equal(pending.status, 'PENDING'); assert.equal(pending.attempt_lease_id, undefined); assert.equal(pending.approved_hash, undefined);
  await proposals.commit(user, proposal.id, { title: 'New explicit review' }, '"original"');
  assert.equal(providerCalls, 2); assert.equal((await db('calendar_proposals').where({ id: proposal.id }).first()).data.status, 'APPLIED');
});

test('an expired attempt cannot reset or clear a newer exact-payload recovery lease', { skip: !enabled, timeout: 5000 }, async () => {
  let firstEntered!: () => void, secondEntered!: () => void, releaseFirst!: () => void, releaseSecond!: () => void, providerCalls = 0;
  const firstStarted = new Promise<void>(resolve => { firstEntered = resolve; }), secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const controlled = {
    ...calendar,
    mutate: async () => {
      await db.raw('SELECT 1'); providerCalls++;
      if (providerCalls === 1) { firstEntered(); await firstGate; throw new CalendarError(409, 'CALENDAR_CONFLICT', 'Late old attempt error'); }
      secondEntered(); await secondGate; return { ...meeting, etag: '"saved"' };
    },
  } as unknown as CalendarService;
  const proposals = new CalendarProposalService(db, controlled, { ensureMembership: async () => undefined } as never);
  const proposal = await proposals.propose(user, 'workspace', ref, 'PATCH', { title: 'Approved review' }, 'controlled-expired-attempt');
  const first = proposals.commit(user, proposal.id, { title: 'Approved review' }, '"original"');
  const firstRejected = assert.rejects(first, (e: unknown) => e instanceof CalendarError && e.code === 'CALENDAR_CONFLICT');
  await firstStarted;
  const old = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
  await db('calendar_proposals').where({ id: proposal.id }).update({ data: db.raw("jsonb_set(data, '{attempt_lease_until}', '\"2020-01-01T00:00:00Z\"'::jsonb)") });
  const second = proposals.commit(user, proposal.id, { title: 'Approved review' }, '"original"');
  await secondStarted;
  try {
    const recovered = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
    assert.notEqual(recovered.attempt_lease_id, old.attempt_lease_id); assert.equal(recovered.approved_hash, old.approved_hash);
    releaseFirst(); await firstRejected;
    const afterOldError = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
    assert.equal(afterOldError.status, 'APPLYING'); assert.equal(afterOldError.attempt_lease_id, recovered.attempt_lease_id); assert.equal(afterOldError.approved_hash, recovered.approved_hash);
    await assert.rejects(proposals.commit(user, proposal.id, { title: 'Different review' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_ALREADY_APPROVED');
    await assert.rejects(proposals.commit(user, proposal.id, { title: 'Approved review' }, '"original"'), (e: unknown) => e instanceof CalendarError && e.code === 'ACTION_IN_PROGRESS');
    assert.equal(providerCalls, 2);
  } finally { releaseFirst(); releaseSecond(); await firstRejected; await second; }
  const applied = (await db('calendar_proposals').where({ id: proposal.id }).first()).data;
  assert.equal(applied.status, 'APPLIED'); assert.equal(applied.attempt_lease_id, undefined); assert.equal(applied.attempt_lease_until, undefined);
  assert.equal((await db('calendar_audit').whereRaw("data->>'action' = 'approve_and_apply'")).length, 1);
});

test('signed Agent tools can propose but cannot approve, impersonate another selection or bypass browser origin policy', { skip: !enabled }, async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get('X-Test-User') === user) req.userContext = { userId: user, externalId: 'fixture', displayName: 'Fixture', isAdmin: false }; next(); });
  app.use('/v1', calendarRoutes(calendar)); app.use('/v1', calendarProposalRoutes(service));
  app.use('/internal', internalAgentRoutes({} as never, calendar, { isDeactivated: async () => false } as never, { ensureMembership: async () => undefined } as never, service));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = signAgentContextToken({ userId: user, workspaceId: 'workspace', calendarEventRefs: [ref] })!;
  const agentHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = { selected_event_ref: ref, method: 'PATCH', input: { title: 'Agent draft' }, idempotency_key: 'http-action-key' };
  try {
    const proposed = await fetch(`${base}/internal/calendar/proposals`, { method: 'POST', headers: agentHeaders, body: JSON.stringify(body) });
    assert.equal(proposed.status, 202); const proposal = await proposed.json() as { id: string };
    assert.equal(writes.length, 0);
    const commitUrl = `${base}/v1/calendar/proposals/${proposal.id}/commit`, commitBody = JSON.stringify({ input: { title: 'Human review' }, etag: '"original"' });
    assert.equal((await fetch(commitUrl, { method: 'POST', headers: { ...agentHeaders, 'X-Test-User': user }, body: commitBody })).status, 403);
    assert.equal((await fetch(commitUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: commitBody })).status, 401);
    assert.equal((await fetch(commitUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user, Origin: 'https://untrusted.invalid' }, body: commitBody })).status, 403);
    assert.equal((await fetch(`${base}/internal/calendar/proposals`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ ...body, selected_event_ref: eventRef(source, 'other') }) })).status, 403);
    assert.equal(writes.length, 0);
    assert.equal((await fetch(commitUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user }, body: commitBody })).status, 200);
    assert.equal(writes.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
