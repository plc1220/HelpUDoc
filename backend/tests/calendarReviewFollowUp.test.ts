import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import express from 'express';
import calendarRoutes from '../src/api/calendar';
import { CalendarService } from '../src/services/calendarService';
import { CalendarError, eventRef, sourceKey } from '../src/services/calendarModel';
import { CalendarReviewFollowUpService, ensureCalendarReviewFollowUpSchema } from '../src/services/calendarReviewFollowUpService';
import { WorkspaceService } from '../src/services/workspaceService';
import type { DatabaseService } from '../src/services/databaseService';

// CI explicitly enables this suite with a PostgreSQL service. No real calendar,
// model credentials, external recipients or calendar mutations are involved.
const enabled = process.env.RUN_CALENDAR_REVIEW_TESTS === '1';
const schema = `calendar_review_${randomUUID().replaceAll('-', '')}`;
const user = randomUUID(), otherUser = randomUUID(), workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
const threadId = randomUUID(), unrelatedThreadId = randomUUID();
const event_ref = eventRef(sourceKey('calendar:fixture', 'primary'), 'review-1');
const start = '2026-11-17T10:00:00.000Z';
let db: Knex, admin: Knex, now: Date, currentEvent: any, revoked: boolean, unavailable: boolean, providerReads: number;
let service: CalendarReviewFollowUpService;
let workspace: WorkspaceService;
let beforeProviderRead: (() => void) | undefined;
const calendar = {
  event: async (actor: string, ref: string) => {
    assert.equal(actor, user); assert.equal(ref, event_ref); providerReads++; beforeProviderRead?.();
    if (revoked) throw new CalendarError(403, 'PERMISSION_DENIED', 'Access revoked');
    if (unavailable) throw new CalendarError(503, 'PROVIDER_UNAVAILABLE', 'Retry later');
    if (currentEvent.status === 'cancelled') throw new CalendarError(404, 'NOT_FOUND', 'Meeting was cancelled');
    return structuredClone(currentEvent);
  },
};
const makeService = () => new CalendarReviewFollowUpService(db, calendar as any, workspace, {
  getThread: async (wid: string, tid: string, actor: string) => {
    await workspace.ensureMembership(wid, actor);
    const row = await db('workspace_team_threads').where({ workspaceId: wid, id: tid }).first();
    if (!row) throw new CalendarError(404, 'NOT_FOUND', 'Thread not found');
    return row;
  },
} as any, () => now);
const input = () => ({ event_ref, workspace_id: workspaceId, file_path: 'proposal.docx', thread_id: threadId, lead_minutes: 30 });
const posts = () => db('workspace_team_messages').where({ authorType: 'lumo' });

before(async () => {
  if (!enabled) return;
  const connection = process.env.CALENDAR_REVIEW_DATABASE_URL || process.env.DATABASE_URL || 'postgres://helpudoc:helpudoc@127.0.0.1:5432/helpudoc';
  admin = knex({ client: 'pg', connection });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 10 } });
  await db.schema.createTable('users', t => { t.uuid('id').primary(); t.text('status').defaultTo('active'); });
  await db.schema.createTable('workspaces', t => { t.uuid('id').primary(); t.uuid('ownerId'); t.text('name'); t.text('visibility'); t.text('status'); t.text('editingPolicy'); t.uuid('teamId'); t.timestamp('createdAt'); t.timestamp('updatedAt'); });
  await db.schema.createTable('workspace_members', t => { t.uuid('workspaceId'); t.uuid('userId'); t.text('role'); t.boolean('canEdit'); t.unique(['workspaceId', 'userId']); });
  await db.schema.createTable('files', t => { t.increments('id'); t.uuid('workspaceId'); t.text('name'); t.timestamp('deletedAt'); t.text('status'); t.integer('version'); t.integer('approvedAtVersion'); });
  await db.schema.createTable('workspace_collaboration_objects', t => { t.uuid('id').primary(); t.uuid('workspaceId'); t.integer('fileId'); t.text('filePath'); t.text('type'); t.text('visibility'); t.text('status'); t.text('title'); t.text('body'); t.timestamp('createdAt').defaultTo(db.fn.now()); });
  await db.schema.createTable('workspace_team_threads', t => { t.uuid('id').primary(); t.uuid('workspaceId'); t.uuid('rootMessageId'); t.text('title'); t.uuid('createdBy'); t.text('status').defaultTo('open'); t.uuid('resolvedBy'); t.timestamp('resolvedAt'); t.bigInteger('lastMessageSeq').defaultTo(1); t.timestamp('lastActivityAt').defaultTo(db.fn.now()); t.timestamp('createdAt').defaultTo(db.fn.now()); t.timestamp('updatedAt').defaultTo(db.fn.now()); });
  await db.schema.createTable('workspace_team_messages', t => { t.uuid('id').primary(); t.uuid('workspaceId'); t.uuid('threadId'); t.bigInteger('sequence'); t.uuid('originVersionId'); t.uuid('authorId'); t.text('authorType'); t.text('body'); t.uuid('replyToMessageId'); t.uuid('threadRootId'); t.boolean('mentionsLumo'); t.text('clientMessageId'); t.text('clientPayloadHash'); t.jsonb('metadata'); t.timestamp('createdAt').defaultTo(db.fn.now()); t.timestamp('updatedAt').defaultTo(db.fn.now()); t.unique(['threadId', 'sequence']); });
  await ensureCalendarReviewFollowUpSchema(db);
  workspace = new WorkspaceService({ getDb: () => db } as DatabaseService);
});
beforeEach(async () => {
  if (!enabled) return;
  await db.raw('TRUNCATE calendar_review_follow_up_audit, calendar_review_follow_up_rules, workspace_team_messages, workspace_team_threads, workspace_collaboration_objects, files, workspace_members, workspaces, users RESTART IDENTITY CASCADE');
  await db('users').insert([{ id: user }, { id: otherUser }]);
  await db('workspaces').insert([{ id: workspaceId, ownerId: user, name: 'Review', visibility: 'team', status: 'active' }, { id: otherWorkspaceId, ownerId: otherUser, name: 'Unrelated', visibility: 'team', status: 'active' }]);
  await db('workspace_members').insert({ workspaceId, userId: user, role: 'owner', canEdit: true });
  await db('files').insert({ workspaceId, name: 'proposal.docx', status: 'draft', version: 1 });
  await db('workspace_team_threads').insert([{ id: threadId, workspaceId, rootMessageId: randomUUID() }, { id: unrelatedThreadId, workspaceId: otherWorkspaceId, rootMessageId: randomUUID() }]);
  await db('workspace_collaboration_objects').insert([
    { id: randomUUID(), workspaceId, fileId: 1, filePath: 'proposal.docx', type: 'annotation', visibility: 'workspace_audience', status: 'open', title: 'Confirm pricing', body: 'Check the agreed rate' },
    { id: randomUUID(), workspaceId, fileId: 1, filePath: 'proposal.docx', type: 'annotation', visibility: 'private', status: 'open', title: 'PRIVATE SECRET', body: 'PRIVATE SECRET' },
    { id: randomUUID(), workspaceId, fileId: 1, filePath: 'proposal.docx', type: 'annotation', visibility: 'workspace_audience', status: 'resolved', title: 'ALREADY RESOLVED', body: 'ALREADY RESOLVED' },
  ]);
  now = new Date('2026-11-17T09:00:00Z'); revoked = unavailable = false; providerReads = 0; beforeProviderRead = undefined;
  currentEvent = { id: event_ref, kind: 'MEETING', title: 'Review', start, end: '2026-11-17T11:00:00Z', etag: '"v1"', all_day: false, sync_state: 'HEALTHY', recurrence: [], capabilities: { can_edit: false, can_delete: false } };
  service = makeService();
});
after(async () => { if (db) await db.destroy(); if (admin) { await admin.raw('DROP SCHEMA ?? CASCADE', [schema]); await admin.destroy(); } });

test('an explicit rule posts pending shared items once to the selected thread across duplicate deliveries, concurrent workers and restart', { skip: !enabled }, async () => {
  const rule = await service.create(user, input());
  await service.tick(); assert.equal((await posts()).length, 0, 'never post before the lead window');
  now = new Date('2026-11-17T09:31:00Z');
  await Promise.all([service.tick(), makeService().tick(), makeService().tick()]);
  await makeService().tick();
  const messages = await posts(); assert.equal(messages.length, 1); assert.equal(messages[0].threadId, threadId); assert.equal(messages[0].workspaceId, workspaceId);
  assert.match(messages[0].body, /Confirm pricing|Check the agreed rate/);
  assert.doesNotMatch(messages[0].body, /PRIVATE SECRET|ALREADY RESOLVED/);
  assert.equal((await db('workspace_team_messages').where({ threadId: unrelatedThreadId })).length, 0);
  const audit = await service.audit(user, rule.id); assert.equal(audit.length, 1); assert.equal(audit[0].outcome, 'posted'); assert.equal(audit[0].message_id, messages[0].id);
  assert.ok(providerReads >= 2, 'fresh provider checks occur after opt-in');
});

test('a transient provider failure retries after a worker restart without losing the durable rule', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); unavailable = true;
  await service.tick(); assert.equal((await posts()).length, 0);
  unavailable = false; await makeService().tick(); await makeService().tick();
  assert.equal((await posts()).length, 1); assert.equal((await service.audit(user, rule.id)).filter(a => a.outcome === 'posted').length, 1);
});

test('moving an occurrence prevents an obsolete post and the new due window produces only one follow-up', { skip: !enabled }, async () => {
  await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); currentEvent.start = '2026-11-17T12:00:00Z';
  await service.tick(); assert.equal((await posts()).length, 0);
  now = new Date('2026-11-17T11:31:00Z'); await makeService().tick(); await makeService().tick(); assert.equal((await posts()).length, 1);
  currentEvent.start = '2026-11-17T13:00:00Z'; now = new Date('2026-11-17T12:31:00Z'); await makeService().tick();
  assert.equal((await posts()).length, 1, 'moving an already posted occurrence never creates another post');
});

test('cancelled and revoked events block execution and retain durable audit outcomes', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); currentEvent.status = 'cancelled';
  await service.tick(); await makeService().tick(); assert.equal((await posts()).length, 0); assert.ok((await service.audit(user, rule.id)).length > 0);
});

test('revoked calendar access and stale cached events cannot produce a post', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); revoked = true;
  await service.tick(); assert.equal((await posts()).length, 0); assert.ok((await service.audit(user, rule.id)).length > 0);
  revoked = false; currentEvent.sync_state = 'STALE'; await makeService().tick(); assert.equal((await posts()).length, 0);
});

test('workspace revocation, mismatched destinations and disabled rules cannot post', { skip: !enabled }, async () => {
  await assert.rejects(() => service.create(user, { ...input(), thread_id: unrelatedThreadId }));
  await assert.rejects(() => service.create(otherUser, input()));
  const rule = await service.create(user, input()); await assert.rejects(() => service.disable(otherUser, rule.id));
  await service.disable(user, rule.id); now = new Date('2026-11-17T09:31:00Z'); await service.tick(); assert.equal((await posts()).length, 0);
  const next = await service.create(user, input());
  await db('workspaces').where({ id: workspaceId }).update({ ownerId: otherUser }); await db('workspace_members').where({ workspaceId, userId: user }).del();
  await service.tick(); assert.equal((await posts()).length, 0); assert.ok((await service.audit(user, next.id)).length > 0);
});

test('a review without pending shared items records a no-op and never posts private notes', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); await db('workspace_collaboration_objects').where({ visibility: 'workspace_audience' }).update({ status: 'resolved' });
  now = new Date('2026-11-17T09:31:00Z'); await service.tick(); await makeService().tick(); assert.equal((await posts()).length, 0); assert.equal((await service.audit(user, rule.id)).length, 1);
});

test('public follow-up routes require a signed-in browser user and reject untrusted origins and agent bearers', { skip: !enabled }, async () => {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { if (req.get('x-test-user')) (req as any).userContext = { userId: req.get('x-test-user') }; next(); });
  app.use(calendarRoutes({} as CalendarService, service));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/calendar/review-follow-ups`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user, Origin: 'https://untrusted.example' }, body: JSON.stringify(input()) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user, Authorization: 'Bearer arbitrary-agent-token' }, body: JSON.stringify(input()) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify(input()) })).status, 201);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Each delivery below boots the real domain + canonical thread store in a fresh
// Node process against the SAME durable rows, as after a worker restart.
const restartedWorker = () => new Promise<void>((resolve, reject) => {
  const worker = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', path.join(__dirname, 'fixtures/calendarReviewWorker.ts')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, CALENDAR_REVIEW_TEST_SCHEMA: schema, CALENDAR_REVIEW_TEST_EVENT: JSON.stringify(currentEvent), CALENDAR_REVIEW_TEST_NOW: now.toISOString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  worker.stdout.on('data', data => { output += data; }); worker.stderr.on('data', data => { output += data; });
  worker.on('error', reject); worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`Restart worker exited ${code}: ${output}`)));
});

test('separate worker processes redeliver against persisted state after restart and commit one canonical message', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z');
  await restartedWorker(); await Promise.all([restartedWorker(), restartedWorker()]);
  const messages = await posts(); assert.equal(messages.length, 1); assert.equal(messages[0].threadId, threadId);
  const audit = await service.audit(user, rule.id); assert.equal(audit.length, 1); assert.equal(audit[0].message_id, messages[0].id);
});

test('failure between message append and audit commit rolls both back; retry after restart posts once', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z');
  await db.raw(`CREATE FUNCTION fail_review_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'simulated worker crash before commit'; END $fn$`);
  await db.raw('CREATE TRIGGER fail_review_audit BEFORE INSERT ON calendar_review_follow_up_audit FOR EACH ROW EXECUTE FUNCTION fail_review_audit()');
  try { await service.tick(); assert.equal((await posts()).length, 0, 'uncommitted post must roll back with failed audit'); }
  finally { await db.raw('DROP TRIGGER fail_review_audit ON calendar_review_follow_up_audit'); await db.raw('DROP FUNCTION fail_review_audit()'); }
  await restartedWorker(); await makeService().tick(); assert.equal((await posts()).length, 1); assert.equal((await service.audit(user, rule.id)).length, 1);
});


test('a provider move between the due check and final read prevents an obsolete post', { skip: !enabled }, async () => {
  await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); providerReads = 0;
  beforeProviderRead = () => { if (providerReads === 2) { currentEvent.start = '2026-11-17T12:00:00Z'; currentEvent.etag = '"moved"'; } };
  await service.tick(); assert.equal((await posts()).length, 0);
  beforeProviderRead = undefined; now = new Date('2026-11-17T11:31:00Z'); await restartedWorker();
  assert.equal((await posts()).length, 1); assert.match((await posts())[0].body, /12:00:00/);
});

test('a cancellation between the due check and final read blocks delivery durably', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); providerReads = 0;
  beforeProviderRead = () => { if (providerReads === 2) currentEvent.status = 'cancelled'; };
  await service.tick(); assert.equal((await posts()).length, 0);
  assert.equal((await service.audit(user, rule.id))[0].outcome, 'cancelled');
  beforeProviderRead = undefined; await makeService().tick(); assert.equal((await posts()).length, 0);
});

test('a deactivated rule owner cannot opt in or execute a previously authorized rule', { skip: !enabled }, async () => {
  const rule = await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z');
  await db('users').where({ id: user }).update({ status: 'inactive' });
  await assert.rejects(() => service.create(user, input()), /active user/);
  await makeService().tick(); assert.equal((await posts()).length, 0); assert.equal((await service.audit(user, rule.id))[0].outcome, 'blocked');
});

test('body-only shared annotations retain bounded pending text with escaped Markdown and no private leakage', { skip: !enabled }, async () => {
  await db('workspace_collaboration_objects').where({ visibility: 'workspace_audience', status: 'open' }).update({ title: '   ', body: 'Please confirm\n[pricing](https://example.com) ' + 'x'.repeat(400) });
  await service.create(user, input()); now = new Date('2026-11-17T09:31:00Z'); await service.tick();
  const messages = await posts(); assert.equal(messages.length, 1);
  assert.ok(messages[0].body.includes('Please confirm \\[pricing\\]\\(https://example.com\\)'), 'body text remains visible with Markdown punctuation escaped');
  assert.doesNotMatch(messages[0].body, /PRIVATE SECRET|x{201}/);
  assert.equal(messages[0].body.split('\n').filter((line: string) => line.startsWith('- ')).length, 1, 'embedded newlines cannot create additional pending rows');
});
