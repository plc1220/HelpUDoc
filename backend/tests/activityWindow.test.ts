import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveActivityWindow,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_WINDOW_DAYS,
  MAX_ACTIVITY_PAGE,
} from '../src/services/activityService';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

test('page 1 anchors on now and reaches back one month', () => {
  const w = resolveActivityWindow({}, NOW);
  assert.equal(w.page, 1);
  assert.equal(w.offset, 0);
  assert.equal(w.anchor.getTime(), NOW);
  assert.equal(w.since.getTime(), NOW - ACTIVITY_WINDOW_DAYS * DAY);
});

test('offset advances by a whole page', () => {
  assert.equal(resolveActivityWindow({ page: 2 }, NOW).offset, ACTIVITY_PAGE_SIZE);
  assert.equal(resolveActivityWindow({ page: 5 }, NOW).offset, 4 * ACTIVITY_PAGE_SIZE);
});

test('fetch depth covers the offset plus one probe row', () => {
  // The extra row is what makes hasMore evidence rather than a guess.
  const w = resolveActivityWindow({ page: 3 }, NOW);
  assert.equal(w.fetchDepth, w.offset + ACTIVITY_PAGE_SIZE + 1);
});

test('the window floor follows the anchor, not the clock', () => {
  // Otherwise paging backwards would silently widen the month as time passed.
  const before = new Date(NOW - 10 * DAY).toISOString();
  const w = resolveActivityWindow({ before }, NOW);
  assert.equal(w.anchor.toISOString(), before);
  assert.equal(w.since.getTime(), Date.parse(before) - ACTIVITY_WINDOW_DAYS * DAY);
});

test('a future anchor is pulled back to now', () => {
  const w = resolveActivityWindow({ before: new Date(NOW + 5 * DAY).toISOString() }, NOW);
  assert.equal(w.anchor.getTime(), NOW);
});

test('an unusable anchor falls back to now instead of failing', () => {
  // A stale or hand-edited bookmark should show the current feed.
  for (const before of ['', 'not-a-date', 'null', '2026-13-45']) {
    const w = resolveActivityWindow({ before }, NOW);
    assert.equal(w.anchor.getTime(), NOW, `anchor for ${JSON.stringify(before)}`);
  }
});

test('page numbers are clamped, never negative or unbounded', () => {
  assert.equal(resolveActivityWindow({ page: 0 }, NOW).page, 1);
  assert.equal(resolveActivityWindow({ page: -7 }, NOW).page, 1);
  assert.equal(resolveActivityWindow({ page: 1.9 }, NOW).page, 1);
  assert.equal(resolveActivityWindow({ page: 99999 }, NOW).page, MAX_ACTIVITY_PAGE);
});

test('a non-numeric page is treated as the first page', () => {
  assert.equal(resolveActivityWindow({ page: Number.NaN }, NOW).page, 1);
  assert.equal(resolveActivityWindow({ page: undefined }, NOW).page, 1);
});

test('the deepest allowed page cannot ask for an unbounded fetch', () => {
  const w = resolveActivityWindow({ page: MAX_ACTIVITY_PAGE }, NOW);
  assert.equal(w.fetchDepth, (MAX_ACTIVITY_PAGE - 1) * ACTIVITY_PAGE_SIZE + ACTIVITY_PAGE_SIZE + 1);
  assert.ok(w.fetchDepth <= 1001, `fetch depth ${w.fetchDepth} is larger than intended`);
});
