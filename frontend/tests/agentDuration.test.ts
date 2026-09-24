import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentDurationBounds } from '../src/utils/agentDuration.ts';

const message = {
  id: 1, conversationId: 'chat', sender: 'agent' as const, text: 'Done',
  createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:03:00Z',
  toolEvents: [{ id: 'last', name: 'write_file', status: 'completed' as const,
    startedAt: '2026-09-17T00:01:59Z', finishedAt: '2026-09-17T00:01:59.100Z' }],
  metadata: { progressEvents: [{ phase: 'completed', label: 'Completed response generation', timestamp: '2026-09-17T00:02:00Z' }] },
};

test('summary includes the entire run and stays frozen on history reload', () => {
  const bounds = getAgentDurationBounds(message, false, Date.parse('2026-09-18T00:00:00Z'))!;
  assert.equal(Date.parse(bounds.finishedAt) - Date.parse(bounds.startedAt), 120000);
});
test('running duration advances even after the last tool finishes', () => {
  const bounds = getAgentDurationBounds(message, true, Date.parse('2026-09-17T00:02:30Z'))!;
  assert.equal(Date.parse(bounds.finishedAt) - Date.parse(bounds.startedAt), 150000);
});
test('tool-free historical runs use the persisted message timestamps', () => {
  const bounds = getAgentDurationBounds({ ...message, toolEvents: [], metadata: {} }, false, Date.now())!;
  assert.equal(Date.parse(bounds.finishedAt) - Date.parse(bounds.startedAt), 180000);
});
test('missing or invalid timing is not displayed as a fabricated zero', () => {
  assert.equal(getAgentDurationBounds({ ...message, createdAt: 'invalid', updatedAt: undefined, toolEvents: [], metadata: {} }, false, Date.now()), undefined);
});
