import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { resolveCalendarSourceScope } from '../src/api/agent/runs';
import internalAgentRoutes from '../src/api/internalAgent';
import { signAgentContextToken } from '../src/services/agentToken';
import { eventRef, sourceKey } from '../src/services/calendarModel';

const source = sourceKey('calendar:fixture', 'primary'), ref = eventRef(source, 'selected');
test('calendar-wide context is separately authorized and bound to the selected source', async () => {
  const calls: unknown[][] = [];
  const service = { authorizeSource: async (...args: unknown[]) => { calls.push(args); } } as never;
  assert.equal(await resolveCalendarSourceScope('user', ref, undefined, service), undefined);
  await assert.rejects(resolveCalendarSourceScope('user', undefined, source, service));
  await assert.rejects(resolveCalendarSourceScope('user', ref, sourceKey('calendar:other', 'private'), service));
  assert.equal(calls.length, 0);
  assert.deepEqual(await resolveCalendarSourceScope('user', ref, source, service), [source]);
  assert.deepEqual(calls, [['user', source]]);
});

test('selected-event JWT cannot enumerate a calendar without its additional signed list capability', async () => {
  let timelineReads = 0;
  const calendar = { event: async () => ({ id: ref }), timeline: async () => { timelineReads++; return { generated_at: new Date().toISOString(), partial_sources: [{ calendar_id: 'other', reason: 'Private calendar status' }], items: [{ id: 'selected-calendar-event', kind: 'MEETING', calendar_id: source }, { id: 'other-calendar-private-event', kind: 'MEETING', calendar_id: 'other' }, { id: 'private-job', kind: 'AUTOMATION' }] }; } };
  const app = express(); app.use('/internal', internalAgentRoutes({} as never, calendar as never, { isDeactivated: async () => false } as never, { ensureMembership: async () => undefined } as never));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/calendar/events?${new URLSearchParams({ event_ref: ref, from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' })}`;
  const request = (sources?: string[]) => fetch(base, { headers: { Authorization: `Bearer ${signAgentContextToken({ userId: 'user', workspaceId: 'workspace', calendarEventRefs: [ref], calendarSourceIds: sources })}` } });
  try {
    assert.equal((await request()).status, 403); assert.equal((await request(['other'])).status, 403); assert.equal(timelineReads, 0);
    const permitted = await request([source]); assert.equal(permitted.status, 200);
    const response = await permitted.json() as { items: Array<{ id: string }>; partial_sources?: unknown };
    assert.deepEqual(response.items.map(item => item.id), ['selected-calendar-event']); assert.equal(response.partial_sources, undefined);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
