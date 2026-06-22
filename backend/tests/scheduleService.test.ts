import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNextRunAt, parseCronExpression } from '../src/services/scheduleService';

test('parseCronExpression accepts standard five-field cron syntax', () => {
  const parsed = parseCronExpression('*/15 9-17 * * 1,3,5');
  assert.equal(parsed.minute.has(0), true);
  assert.equal(parsed.minute.has(15), true);
  assert.equal(parsed.hour.has(9), true);
  assert.equal(parsed.hour.has(17), true);
  assert.equal(parsed.dayOfWeek.has(3), true);
});

test('parseCronExpression treats 7 as Sunday for day-of-week', () => {
  const parsed = parseCronExpression('0 9 * * 7');
  assert.equal(parsed.dayOfWeek.has(0), true);
});

test('computeNextRunAt returns the next matching UTC minute', () => {
  const next = computeNextRunAt('30 9 * * *', 'UTC', new Date('2026-06-21T09:29:00.000Z'));
  assert.equal(next.toISOString(), '2026-06-21T09:30:00.000Z');
});

test('computeNextRunAt skips to the next day after a matching minute has passed', () => {
  const next = computeNextRunAt('30 9 * * *', 'UTC', new Date('2026-06-21T09:30:00.000Z'));
  assert.equal(next.toISOString(), '2026-06-22T09:30:00.000Z');
});

test('computeNextRunAt rejects invalid timezone values', () => {
  assert.throws(
    () => computeNextRunAt('0 9 * * *', 'Not/AZone', new Date('2026-06-21T00:00:00.000Z')),
    /Invalid timezone/,
  );
});
