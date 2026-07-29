import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRunOwnedAgentText } from '../src/services/conversationService';

const runMetadata = { runId: 'run-1', status: 'running' };

test('a delayed assistant checkpoint cannot replace newer streamed text with an earlier prefix', () => {
  assert.equal(
    mergeRunOwnedAgentText(
      'The full answer includes the newest streamed chunk.',
      'The full answer',
      runMetadata,
      runMetadata,
    ),
    'The full answer includes the newest streamed chunk.',
  );
});

test('a delayed assistant checkpoint cannot replace newer streamed text with a suffix', () => {
  const complete = 'Earlier analysis.\n\n50.27 | $58.96 | Final summary.';
  assert.equal(
    mergeRunOwnedAgentText(
      complete,
      '50.27 | $58.96 | Final summary.',
      runMetadata,
      { ...runMetadata, status: 'completed' },
    ),
    complete,
  );
});

test('a newer cumulative assistant snapshot extends the durable message', () => {
  assert.equal(
    mergeRunOwnedAgentText(
      'The full answer',
      'The full answer includes the newest streamed chunk.',
      runMetadata,
      runMetadata,
    ),
    'The full answer includes the newest streamed chunk.',
  );
});

test('a different run may replace the previous turn body', () => {
  assert.equal(
    mergeRunOwnedAgentText(
      'Previous run output',
      'Regenerated output',
      { runId: 'run-1' },
      { runId: 'run-2' },
    ),
    'Regenerated output',
  );
});
