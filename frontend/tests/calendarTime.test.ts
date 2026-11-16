import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, intersectsDay, localTime, viewDays, zonedInstant } from '../src/features/calendar/calendarTime.ts';

test('calendar respects IANA offsets, DST gaps and an unchanged ambiguous occurrence', () => {
  assert.equal(zonedInstant('2026-11-05T10:00', 'Asia/Kuala_Lumpur'), '2026-11-05T02:00:00.000Z');
  assert.throws(() => zonedInstant('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  const laterOccurrence = '2026-11-01T06:30:00Z';
  assert.equal(localTime(laterOccurrence, 'America/New_York'), '2026-11-01T01:30');
  assert.equal(zonedInstant('2026-11-01T01:30', 'America/New_York', laterOccurrence), laterOccurrence);
});
test('month navigation clamps dates and day intersections use exclusive ends', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-02-01', 1), '2026-03-01');
  assert.equal(viewDays('2026-11-05', 'week')[0], '2026-11-02');
  assert.equal(intersectsDay({ start: '2026-11-05', end: '2026-11-06', all_day: true }, '2026-11-06', 'UTC'), false);
  assert.equal(intersectsDay({ start: '2026-11-05T23:00:00Z', end: '2026-11-06T00:00:00Z' }, '2026-11-06', 'UTC'), false);
});
