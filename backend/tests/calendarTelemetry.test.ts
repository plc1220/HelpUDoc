import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { CalendarTelemetry, calendarProviderAction, type CalendarProviderAction, type CalendarSignal } from '../src/services/calendarTelemetry';
import calendarTelemetryRoutes from '../src/api/calendarTelemetry';
import type { UserService } from '../src/services/userService';
import calendarActivityRoutes from '../src/api/calendarActivity';
import calendarRoutes from '../src/api/calendar';
import { calendarTelemetry } from '../src/services/calendarTelemetry';

test('provider telemetry separates required error classes and counts retry attempts with latency buckets', () => {
  const metrics = new CalendarTelemetry(() => 1794000000000);
  for (const [status, durationMs] of [[200, 50], [401, 51], [403, 100], [404, 500], [409, 501], [410, 1000], [412, 2000], [429, 20000], [503, 45000]] as const) metrics.recordProvider({ action: 'event_get', status, durationMs });
  metrics.recordProvider({ action: 'event_get', status: 'network_error', durationMs: 125000 });
  const snapshot = metrics.snapshot(), row = snapshot.provider[0];
  assert.equal(row.attempts, 10); assert.equal(row.statuses['2xx'], 1); assert.equal(row.statuses['5xx'], 1); assert.equal(row.statuses.network_error, 1);
  for (const status of ['401', '403', '404', '409', '410', '412', '429'] as const) assert.equal(row.statuses[status], 1);
  assert.equal(row.latency_ms.count, 10); assert.equal(row.latency_ms.max_ms, 125000);
  assert.deepEqual(row.latency_ms.buckets.find(bucket => bucket.le_ms === 50), { le_ms: 50, count: 1 });
  assert.deepEqual(row.latency_ms.buckets.find(bucket => bucket.le_ms === 100), { le_ms: 100, count: 3 });
  assert.deepEqual(row.latency_ms.buckets.at(-1), { le_ms: '+Inf', count: 10 });
  assert.equal(snapshot.scope, 'process_lifetime');
});

test('browser activity accepts only content-free UI signal enums under Calendar session/origin policy', async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get('X-Test-Identity')) req.userContext = { userId: 'fixture', externalId: 'fixture', displayName: 'Fixture', isAdmin: false }; next(); });
  app.use(calendarRoutes({} as never)); app.use(calendarActivityRoutes());
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/calendar/activity`;
  const request = (body: unknown, headers: Record<string, string> = { 'X-Test-Identity': 'fixture' }) => fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await request({ signal: 'ui_open' }, {})).status, 401);
    assert.equal((await request({ signal: 'ui_open' }, { 'X-Test-Identity': 'fixture', Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await request({ signal: 'mutation_success' })).status, 422);
    assert.equal((await request({ signal: 'ui_open', title: 'Private meeting', event_ref: 'private-reference' })).status, 422);
    assert.equal((await request({ signal: 'ui_open' })).status, 204);
    const snapshot = calendarTelemetry.snapshot(); assert.equal(snapshot.signals.find(signal => signal.name === 'ui_open')?.count, 1);
    assert.ok(!JSON.stringify(snapshot).includes('Private meeting')); assert.ok(!JSON.stringify(snapshot).includes('fixture'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('telemetry labels stay bounded and cannot retain caller identifiers, source text or paths', () => {
  const metrics = new CalendarTelemetry();
  const secret = 'never-retain-user-event-token-text';
  assert.equal(metrics.recordProvider({ action: secret as CalendarProviderAction, status: 200, durationMs: 1 }), false);
  assert.equal(metrics.recordSignal(secret as CalendarSignal), false);
  metrics.recordProvider({ action: 'event_get', status: 200, durationMs: 1, path: secret, userId: secret } as never);
  metrics.recordSyncHealth({ sources: 2, stale: 1, pending: 0, reauth: 0, maxCursorAgeMs: 60000, userId: secret, event: secret } as never);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes(secret));
  for (let i = 0; i < 10000; i++) metrics.recordProvider({ action: 'event_get', status: 200, durationMs: 1 });
  const row = metrics.snapshot().provider[0];
  assert.equal(metrics.snapshot().provider.length, 1); assert.equal(row.attempts, 10001); assert.equal(row.latency_ms.buckets.length, 12);
});

test('signals and source health are explicit, validated and return independent snapshots', () => {
  let now = 1794000000000;
  const metrics = new CalendarTelemetry(() => now);
  metrics.recordSignal('sync_success', 750); metrics.recordSignal('mutation_replayed'); metrics.recordSignal('brief_failed', 45000);
  assert.equal(metrics.recordProvider({ action: 'event_get', status: 999, durationMs: 1 }), false);
  assert.equal(metrics.recordProvider({ action: 'event_get', status: 200, durationMs: NaN }), false);
  assert.equal(metrics.recordSignal('sync_success', -1), false);
  assert.equal(metrics.recordSyncHealth({ sources: 1, pending: 1, stale: 1, reauth: 0, maxCursorAgeMs: 0 }), false);
  assert.equal(metrics.recordSyncHealth({ sources: 4, pending: 1, stale: 1, reauth: 1, maxCursorAgeMs: 90000 }), true);
  const first = metrics.snapshot(); first.signals[0].count = 999; first.signals[0].latency_ms.buckets[0].count = 999; first.sync_health!.sources = 999;
  now += 1000;
  const second = metrics.snapshot();
  assert.equal(second.signals[0].count, 1); assert.equal(second.signals[0].latency_ms.buckets[0].count, 0); assert.equal(second.sync_health!.sources, 4);
  assert.notEqual(second.collected_at, first.collected_at); assert.equal(second.started_at, first.started_at);
  assert.equal(second.signals.find(row => row.name === 'mutation_replayed')!.latency_ms.count, 0);
});

test('canonical adapter paths classify operations without leaking dynamic path or query values', () => {
  const samples: Array<[string, string, boolean, CalendarProviderAction]> = [
    ['/users/me/calendarList?maxResults=250', 'GET', false, 'calendar_list'],
    ['/users/me/calendarList/private%40calendar', 'GET', false, 'calendar_get'],
    ['/calendars/private%40calendar/events?syncToken=secret', 'GET', false, 'event_list'],
    ['/calendars/private%40calendar/events', 'POST', false, 'event_create'],
    ['/calendars/private/events/event-id', 'GET', false, 'event_get'],
    ['/calendars/private/events/event-id?sendUpdates=all', 'PATCH', false, 'event_update'],
    ['/calendars/private/events/event-id', 'DELETE', false, 'event_delete'],
    ['/calendars/private/events/watch', 'POST', false, 'watch_create'],
    ['/channels/stop', 'POST', false, 'watch_stop'],
    ['/files?q=private-name', 'GET', true, 'drive_search'],
    ['/files/private-id?fields=name', 'GET', true, 'drive_metadata'],
    ['/files/private-id?alt=media&supportsAllDrives=true', 'GET', true, 'drive_content'],
    ['/files/private-id/export?mimeType=text%2Fplain', 'GET', true, 'drive_export'],
    ['/private-unrecognized-route', 'GET', false, 'other'],
  ];
  for (const [path, method, drive, expected] of samples) assert.equal(calendarProviderAction(path, method, drive), expected);
});

test('telemetry endpoint requires current database admin authority and never returns source identifiers', async () => {
  let platformAdmin = false, deactivated = false, found = true;
  const users = {
    getUserById: async () => found ? { id: 'fixture-user', status: deactivated ? 'deactivated' : 'active' } : null,
    isPlatformAdmin: async () => platformAdmin,
  } as unknown as UserService;
  const metrics = new CalendarTelemetry();
  const privateLabel = 'private-event-and-user-reference';
  metrics.recordProvider({ action: 'event_get', status: 200, durationMs: 100, eventRef: privateLabel } as never);
  const app = express();
  app.use((req, _res, next) => {
    if (req.get('X-Fixture-Authenticated')) req.userContext = { userId: 'fixture-user', externalId: 'fixture', displayName: 'Fixture', isAdmin: true };
    next();
  });
  app.use('/settings/calendar', calendarTelemetryRoutes(users, metrics));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings/calendar/telemetry`;
  const headers = { 'X-Fixture-Authenticated': 'true' };
  try {
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await fetch(url, { headers })).status, 403, 'forged isAdmin context does not override the database role');
    platformAdmin = true; deactivated = true;
    assert.equal((await fetch(url, { headers })).status, 403, 'deactivated platform admins are denied');
    deactivated = false; found = false;
    assert.equal((await fetch(url, { headers })).status, 401);
    found = true;
    const allowed = await fetch(url, { headers });
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store');
    const text = await allowed.text();
    assert.ok(!text.includes(privateLabel)); assert.ok(!text.includes('fixture-user')); assert.match(text, /event_get/); assert.match(text, /process_lifetime/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
