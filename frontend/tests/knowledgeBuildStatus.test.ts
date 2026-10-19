import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SLOW_STEP_MS,
  describeMemberBuild,
  membersLeftOutOfPublish,
} from '../src/utils/knowledgeBuildStatus.ts';
import type { KnowledgeBaseMember } from '../src/services/knowledgeBaseApi.ts';

const now = new Date('2026-10-16T08:00:00Z');
const member = (patch: Partial<KnowledgeBaseMember>): KnowledgeBaseMember => ({
  knowledgeSourceId: 1,
  title: 'Act 873.pdf',
  type: 'document',
  published: false,
  addedSincePublish: true,
  changedSincePublish: false,
  ...patch,
});
const progress = (patch: Partial<NonNullable<KnowledgeBaseMember['ingestionProgress']>>) => ({
  label: 'Consolidating concepts', percent: 76, queuedAhead: null, stageSince: null, stalled: false, ...patch,
});

test('a running build shows the plain step and percent, never the raw stage', () => {
  const status = describeMemberBuild(member({
    ingestionStatus: 'reducing',
    ingestionStage: 'reducing',
    ingestionProgress: progress({ stageSince: new Date(now.getTime() - 2 * 60_000).toISOString() }),
  }), now);
  assert.deepEqual(status, { tone: 'pending', text: 'Consolidating concepts · 76%', detail: 'For 2 min' });
});

test('a slow step says it is still working', () => {
  const status = describeMemberBuild(member({
    ingestionStatus: 'reducing',
    ingestionProgress: progress({ stageSince: new Date(now.getTime() - SLOW_STEP_MS - 60_000).toISOString() }),
  }), now);
  assert.equal(status.tone, 'pending');
  assert.match((status as { detail: string }).detail, /has run for 6 min.*still working/);
});

test('a queued build says how many files are ahead', () => {
  assert.deepEqual(
    describeMemberBuild(member({ ingestionStatus: 'queued', ingestionProgress: progress({ queuedAhead: 2 }) }), now),
    { tone: 'queued', text: 'Queued · 2 files ahead' },
  );
  assert.deepEqual(
    describeMemberBuild(member({ ingestionStatus: 'queued', ingestionProgress: progress({ queuedAhead: 1 }) }), now),
    { tone: 'queued', text: 'Queued · 1 file ahead' },
  );
  assert.deepEqual(
    describeMemberBuild(member({ ingestionStatus: 'queued', ingestionProgress: progress({ queuedAhead: 0 }) }), now),
    { tone: 'queued', text: 'Queued · starts next' },
  );
});

test('a build whose worker stopped is shown as paused, not failed', () => {
  const status = describeMemberBuild(member({ ingestionStatus: 'reducing', ingestionProgress: progress({ stalled: true }) }), now);
  assert.equal(status.tone, 'stalled');
});

test('a failed build says so and why, instead of "not built"', () => {
  const status = describeMemberBuild(member({
    ingestionStatus: 'failed',
    ingestionError: 'The consolidation step failed: the step took longer than 5 minutes and was stopped.',
  }), now);
  assert.deepEqual(status, {
    tone: 'failed',
    text: 'Build failed',
    detail: 'The consolidation step failed: the step took longer than 5 minutes and was stopped.',
  });
});

test('"not built yet" is kept for a file that never started', () => {
  assert.deepEqual(describeMemberBuild(member({ ingestionStatus: null }), now), { tone: 'idle', text: 'Not built yet' });
  assert.deepEqual(describeMemberBuild(member({ ingestionStatus: 'published', published: true }), now), { tone: 'built' });
});

test('publish leaves out only members with no built version', () => {
  const left = membersLeftOutOfPublish([
    member({ knowledgeSourceId: 1, ingestionStatus: 'failed' }),
    member({ knowledgeSourceId: 2, ingestionStatus: 'queued' }),
    // Being rebuilt, but its earlier version is published with the base.
    member({ knowledgeSourceId: 3, ingestionStatus: 'reducing', published: true }),
    member({ knowledgeSourceId: 4, ingestionStatus: 'published', published: true }),
  ]);
  assert.deepEqual(left.map((item) => item.knowledgeSourceId), [1, 2]);
});

test('concept building shows sections done instead of a fixed percent', () => {
  const status = describeMemberBuild(member({
    ingestionStatus: 'enriching',
    ingestionProgress: progress({ label: 'Building knowledge', percent: 65, sections: { done: 31, total: 48 } }),
  }), now);
  assert.equal((status as { text: string }).text, 'Building knowledge · 31 of 48 sections');
});

test('a document built with lost knowledge is not shown as complete', () => {
  const status = describeMemberBuild(member({
    published: true,
    ingestionStatus: 'published',
    ingestionWarnings: ['Sections were built, but linking concepts across sections failed: the step took longer than 15 minutes and was stopped'],
  }), now);
  assert.equal(status.tone, 'warning');
  assert.equal((status as { text: string }).text, 'Built with warnings');
  assert.deepEqual(
    describeMemberBuild(member({ published: true, ingestionStatus: 'published', ingestionWarnings: [] }), now),
    { tone: 'built' },
  );
});
