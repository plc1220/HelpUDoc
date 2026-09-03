import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatGcsSize,
  gcsBreadcrumbs,
  gcsLeafName,
  normalizeGcsPrefix,
  parentGcsPrefix,
  sortGcsEntries,
} from '../src/utils/gcsPaths.ts';
import type { GcsBrowseEntry } from '../../packages/contracts/src/types.ts';

test('a prefix normalises to "" or a single trailing slash', () => {
  assert.equal(normalizeGcsPrefix(undefined), '');
  assert.equal(normalizeGcsPrefix('   '), '');
  assert.equal(normalizeGcsPrefix('/exports'), 'exports/');
  assert.equal(normalizeGcsPrefix('exports/'), 'exports/');
  assert.equal(normalizeGcsPrefix('exports/2026'), 'exports/2026/');
});

test('parentGcsPrefix climbs one level and stops at the root', () => {
  assert.equal(parentGcsPrefix('exports/2026/09/'), 'exports/2026/');
  assert.equal(parentGcsPrefix('exports/'), '');
  assert.equal(parentGcsPrefix(''), '');
});

test('breadcrumbs are relative to the registration root', () => {
  assert.deepEqual(gcsBreadcrumbs('2026/09/'), [
    { label: '2026', prefix: '2026/' },
    { label: '09', prefix: '2026/09/' },
  ]);

  // A bucket confined to exports/ must not offer a crumb above its own root.
  assert.deepEqual(gcsBreadcrumbs('exports/2026/', 'exports/'), [
    { label: '2026', prefix: 'exports/2026/' },
  ]);
  assert.deepEqual(gcsBreadcrumbs('exports/', 'exports/'), []);
});

test('gcsLeafName reads the last segment of keys and folders alike', () => {
  assert.equal(gcsLeafName('2026/09/q3-report.pdf'), 'q3-report.pdf');
  assert.equal(gcsLeafName('2026/09/'), '09');
  assert.equal(gcsLeafName('report.pdf'), 'report.pdf');
});

test('entries sort folders first, then objects, each alphabetically', () => {
  const entries: GcsBrowseEntry[] = [
    { kind: 'object', name: 'beta.csv', path: 'beta.csv', iconHint: 'sheets' },
    { kind: 'prefix', name: 'zulu', path: 'zulu/', iconHint: 'file' },
    { kind: 'object', name: 'alpha.pdf', path: 'alpha.pdf', iconHint: 'pdf' },
    { kind: 'prefix', name: 'alpha', path: 'alpha/', iconHint: 'file' },
  ];

  assert.deepEqual(
    sortGcsEntries(entries).map((entry) => entry.name),
    ['alpha', 'zulu', 'alpha.pdf', 'beta.csv'],
  );
});

test('sizes render in the largest unit that stays readable', () => {
  assert.equal(formatGcsSize(0), '—');
  assert.equal(formatGcsSize(null), '—');
  assert.equal(formatGcsSize(512), '512 B');
  assert.equal(formatGcsSize(2048), '2.0 KB');
  assert.equal(formatGcsSize(2.2 * 1024 * 1024), '2.2 MB');
  assert.equal(formatGcsSize(88 * 1024 * 1024), '88 MB');
});
