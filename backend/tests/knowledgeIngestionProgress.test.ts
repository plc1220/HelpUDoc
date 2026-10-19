import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQualityWarnings,
  summarizeIngestionProgress,
} from '../src/services/knowledgeIngestionService';

test('a queued build counts the unfinished builds ahead of it', () => {
  const progress = summarizeIngestionProgress({
    runId: 'c',
    status: 'queued',
    activeRunIds: ['a', 'b', 'c', 'd'],
  });
  assert.equal(progress.queuedAhead, 2);
  assert.equal(progress.label, 'Queued');
});

test('a running build reports its plain label and when the step began', () => {
  const progress = summarizeIngestionProgress({
    runId: 'a',
    status: 'reducing',
    activeRunIds: ['a'],
    jobUpdatedAt: new Date('2026-10-16T07:55:44Z'),
    taskStatus: 'processing',
    taskLeaseExpiresAt: new Date('2026-10-16T08:01:00Z'),
    now: new Date('2026-10-16T08:00:00Z'),
  });
  assert.deepEqual(progress, {
    label: 'Consolidating concepts',
    percent: 76,
    queuedAhead: null,
    stageSince: '2026-10-16T07:55:44.000Z',
    stalled: false,
    sections: null,
  });
});

test('a lapsed lease marks the build as stalled', () => {
  const progress = summarizeIngestionProgress({
    runId: 'a',
    status: 'enriching',
    activeRunIds: ['a'],
    taskStatus: 'processing',
    taskLeaseExpiresAt: new Date('2026-10-16T07:59:00Z'),
    now: new Date('2026-10-16T08:00:00Z'),
  });
  assert.equal(progress.stalled, true);
});

test('concept building reports sections done, other steps do not', () => {
  const building = summarizeIngestionProgress({
    runId: 'a', status: 'enriching', activeRunIds: ['a'], sectionsDone: 31, sectionsTotal: 48,
  });
  assert.deepEqual(building.sections, { done: 31, total: 48 });
  const reducing = summarizeIngestionProgress({
    runId: 'a', status: 'reducing', activeRunIds: ['a'], sectionsDone: 48, sectionsTotal: 48,
  });
  assert.equal(reducing.sections, null);
  // A stale count larger than the total never reads as more than 100%.
  const clamped = summarizeIngestionProgress({
    runId: 'a', status: 'enriching', activeRunIds: ['a'], sectionsDone: 60, sectionsTotal: 48,
  });
  assert.deepEqual(clamped.sections, { done: 48, total: 48 });
});

test('only warnings that lose knowledge are surfaced', () => {
  assert.deepEqual(buildQualityWarnings({
    status: 'published',
    warnings: [
      { code: 'reduce_failed', message: 'Sections were built, but linking concepts across sections failed.' },
      { code: 'ocr_low_confidence', message: 'Page 4 OCR confidence 0.62' },
    ],
  }), ['Sections were built, but linking concepts across sections failed.']);
  assert.deepEqual(buildQualityWarnings({
    status: 'partial', failedSourceUnits: 3, discoveredSourceUnits: 120, warnings: [],
  }), ['3 of 120 parts of the document could not be read and are missing.']);
  assert.deepEqual(buildQualityWarnings({ status: 'published', warnings: [] }), []);
  assert.deepEqual(buildQualityWarnings(null), []);
});
