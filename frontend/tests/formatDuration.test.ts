import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDurationBetween, formatDurationMs } from '../src/utils/formatDuration.ts';

/**
 * The reported bug: every agent run read `0m 0s`. The timings were right and the
 * format could not express them — almost every tool call finishes in under a
 * second, and the old formatter floored to whole seconds.
 */

test('a sub-second duration keeps its magnitude', () => {
  assert.equal(formatDurationMs(3), '3ms');
  assert.equal(formatDurationMs(138), '138ms');
  assert.equal(formatDurationMs(204), '204ms');
  assert.equal(formatDurationMs(999), '999ms');
});

test('seconds carry one decimal while a second still means something', () => {
  assert.equal(formatDurationMs(1000), '1.0s');
  assert.equal(formatDurationMs(1849), '1.8s');
  assert.equal(formatDurationMs(6254), '6.3s');
});

test('past ten seconds the decimal stops earning its place', () => {
  assert.equal(formatDurationMs(10_000), '10s');
  assert.equal(formatDurationMs(42_400), '42s');
  assert.equal(formatDurationMs(59_400), '59s');
});

test('minutes appear only once there is a minute', () => {
  assert.equal(formatDurationMs(60_000), '1m 00s');
  assert.equal(formatDurationMs(125_000), '2m 05s');
  assert.equal(formatDurationMs(3_599_000), '59m 59s');
});

test('rounding never produces a sixtieth second', () => {
  assert.equal(formatDurationMs(119_600), '2m 00s');
});

test('hours replace seconds, which stop being the interesting part', () => {
  assert.equal(formatDurationMs(3_600_000), '1h 00m');
  assert.equal(formatDurationMs(4_800_000), '1h 20m');
});

test('a leading zero minute is never printed', () => {
  // `0m 06s` was the old reading for six seconds.
  assert.ok(!formatDurationMs(6000).startsWith('0m'));
  assert.ok(!formatDurationMs(60).startsWith('0m'));
});

test('an unusable input yields nothing rather than a zero', () => {
  // A printed duration is a claim; an absent one is not.
  assert.equal(formatDurationMs(Number.NaN), '');
  assert.equal(formatDurationMs(-1), '');
  assert.equal(formatDurationBetween(undefined, '2026-01-01T00:00:01Z'), '');
  assert.equal(formatDurationBetween('not a date', '2026-01-01T00:00:01Z'), '');
  assert.equal(formatDurationBetween('2026-01-01T00:00:00Z', 'not a date'), '');
});

test('a span measures to now while it is still open', () => {
  const started = '2026-01-01T00:00:00.000Z';
  const now = Date.parse('2026-01-01T00:00:12.000Z');
  assert.equal(formatDurationBetween(started, undefined, now), '12s');
});

test('a span measures to its end once it has one', () => {
  assert.equal(
    formatDurationBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.138Z'),
    '138ms',
  );
});

test('a clock that went backwards reads as no time at all', () => {
  assert.equal(
    formatDurationBetween('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:00.000Z'),
    '0ms',
  );
});
