import assert from 'node:assert/strict';
import test from 'node:test';

import { markInteractionResponseReceived } from '../src/utils/agentProgress.ts';

test('submitted interaction replaces stale awaiting-input activity immediately', () => {
  const events = markInteractionResponseReceived([
    {
      phase: 'clarification',
      label: 'Awaiting your input to proceed',
      status: 'running',
      timestamp: '2026-08-11T00:00:00.000Z',
    },
  ], '2026-08-11T00:01:00.000Z');

  assert.deepEqual(events.map(({ label, status }) => ({ label, status })), [
    { label: 'Input received', status: 'completed' },
    { label: 'Response received', status: 'running' },
  ]);
});

test('submitted interaction does not duplicate an active response marker', () => {
  const events = markInteractionResponseReceived([
    { phase: 'routing', label: 'Response received', status: 'running' },
  ]);

  assert.equal(events.length, 1);
});
