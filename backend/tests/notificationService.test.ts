import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { Knex } from 'knex';
import notificationRoutes from '../src/api/notifications';
import { createNotification, NotificationService } from '../src/services/notificationService';

type Row = Record<string, any>;
function memoryDb() {
  const rows: Row[] = [];
  const db = Object.assign((_table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let limit = Infinity;
    let count = false;
    const matching = () => rows.filter((row) => filters.every((filter) => filter(row)));
    const query: any = {
      where: (values: Row) => { filters.push((row) => Object.entries(values).every(([key, value]) => row[key] === value)); return query; },
      whereNull: (key: string) => { filters.push((row) => row[key] == null); return query; },
      orderBy: () => query,
      limit: (value: number) => { limit = value; return query; },
      count: () => { count = true; return query; },
      first: async () => count ? { count: String(matching().length) } : matching()[0],
      update: async (values: Row) => { matching().forEach((row) => Object.assign(row, values)); },
      insert: (row: Row) => ({ onConflict: (key: string) => ({ ignore: async () => {
        if (!rows.some((existing) => existing[key] === row[key])) rows.push({ ...row, readAt: null, createdAt: new Date().toISOString() });
      } }) }),
      then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(matching().slice(0, limit)).then(resolve, reject),
    };
    return query;
  }, { fn: { now: () => new Date().toISOString() } }) as unknown as Knex;
  return { db, rows };
}
const meta = {
  userId: 'alice', workspaceId: 'workspace', status: 'completed',
  runContext: JSON.stringify({ conversationId: 'conversation', prompt: 'Write the report' }),
};

test('completion retries produce one durable notification with the originating conversation', async () => {
  const { db, rows } = memoryDb();
  const service = new NotificationService(db);
  await service.notifyRun('run', meta);
  await service.notifyRun('run', meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipientUserId, 'alice');
  assert.equal(rows[0].eventType, 'agent.completed');
  assert.equal(rows[0].payload.conversationId, 'conversation');
  assert.equal(rows[0].payload.description, 'Write the report');
});

test('each feedback request alerts once, followed by a separate completion alert', async () => {
  const { db, rows } = memoryDb();
  const service = new NotificationService(db);
  const waiting = { ...meta, status: 'awaiting_approval', pendingInterrupt: JSON.stringify({ interruptId: 'first', title: 'Choose a format' }) };
  await service.notifyRun('run', waiting);
  await service.notifyRun('run', waiting);
  await service.notifyRun('run', { ...waiting, pendingInterrupt: JSON.stringify({ interruptId: 'second' }) });
  await service.notifyRun('run', meta);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].payload.description, 'Choose a format');
  assert.deepEqual(rows.map((row) => row.eventType), ['agent.feedback_required', 'agent.feedback_required', 'agent.completed']);
});

test('running, failed, cancelled and anonymous runs do not produce completion alerts', async () => {
  const { db, rows } = memoryDb();
  const service = new NotificationService(db);
  for (const status of ['queued', 'running', 'failed', 'cancelled']) await service.notifyRun('run', { ...meta, status });
  await service.notifyRun('run', { ...meta, userId: '' });
  assert.equal(rows.length, 0);
});

test('team tasks link to the source message and mentions are deduplicated per recipient', async () => {
  const { db, rows } = memoryDb();
  await new NotificationService(db).notifyRun('run', { ...meta, sharedTeamChannel: 'true', turnId: 'team:message' });
  assert.equal(rows[0].payload.messageId, 'message');
  for (const recipientUserId of ['alice', 'alice', 'bob']) await createNotification(db, {
    recipientUserId, eventType: 'chat.mentioned', resourceType: 'workspace_team_message', resourceId: 'message', eventKey: 'message', payload: {},
  });
  assert.equal(rows.length, 3);
});

test('list, unread count, individual read and read-all are isolated to the recipient', async () => {
  const { db, rows } = memoryDb();
  const service = new NotificationService(db);
  for (let index = 0; index < 105; index++) await service.notifyRun(`run-${index}`, meta);
  await service.notifyRun('bob-run', { ...meta, userId: 'bob' });
  assert.equal((await service.list('alice')).notifications.length, 100);
  assert.equal((await service.list('alice')).unreadCount, 105);
  await service.markRead('alice', rows[105].id);
  assert.equal((await service.list('bob')).unreadCount, 1);
  await service.markRead('alice', rows[0].id);
  assert.equal((await service.list('alice', true)).unreadCount, 104);
  await service.markRead('alice');
  assert.equal((await service.list('alice', true)).notifications.length, 0);
  assert.equal((await service.list('bob')).unreadCount, 1);
});

test('notification API requires authentication and rejects malformed IDs', async () => {
  const { db } = memoryDb();
  const app = express();
  app.use((req, _res, next) => {
    if (req.header('test-user')) req.userContext = { userId: req.header('test-user')! } as typeof req.userContext;
    next();
  });
  app.use('/notifications', notificationRoutes(new NotificationService(db)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/notifications`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(`${url}/read-all`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${url}/invalid/read`, { method: 'POST', headers: { 'test-user': 'alice' } })).status, 400);
    const response = await fetch(url, { headers: { 'test-user': 'alice' } });
    assert.deepEqual(await response.json(), { notifications: [], unreadCount: 0 });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
