import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationMessage } from '../src/types';
import { CLOSING_NOTES, closingNoteFor, mapMessagesToAgentHistory } from '../src/utils/agentHistory.ts';

const user = (text: string) => ({ id: text, sender: 'user', text }) as unknown as ConversationMessage;
const agent = (text: string, metadata: Record<string, unknown> = {}) =>
  ({ id: `a-${text}`, sender: 'agent', text, metadata }) as unknown as ConversationMessage;

test('stopped, failed and unanswered runs close their request instead of disappearing', () => {
  const history = mapMessagesToAgentHistory([
    user('show me the final output for CASE-26-000001'),
    agent('The run was stopped.', { bodySource: 'summary', status: 'cancelled' }),
    user('show me the final output for CASE-26-000571'),
    agent('The run failed: recursion limit', { bodySource: 'summary', status: 'failed' }),
    user('can i have the updated result for CASE-26-000571'),
    agent('', { status: 'awaiting_approval', pendingInterrupt: { kind: 'clarification' } }),
    user('and this one?'),
    agent('Completed successfully.', { bodySource: 'summary', status: 'completed' }),
  ]);

  assert.deepEqual(history.map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(history.filter((e) => e.role === 'assistant').map((e) => e.content), [
    CLOSING_NOTES.cancelled,
    CLOSING_NOTES.failed,
    CLOSING_NOTES.unanswered_question,
    CLOSING_NOTES.no_reply,
  ]);
  // The user's own requests are all still there, word for word.
  assert.equal(history[2].content, 'show me the final output for CASE-26-000571');
});

test('real answers and ordinary messages are sent exactly as before', () => {
  const messages = [user('  hello  '), agent('Here is the answer.', { bodySource: 'assistant', status: 'completed' })];
  assert.deepEqual(mapMessagesToAgentHistory(messages), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Here is the answer.' },
  ]);
});

test('a run still in progress or without status adds nothing', () => {
  assert.equal(closingNoteFor(agent('', { status: 'running' })), null);
  assert.equal(closingNoteFor(agent('', { status: 'queued' })), null);
  assert.equal(closingNoteFor(agent('')), null);
  assert.deepEqual(mapMessagesToAgentHistory([user('q'), agent('', { status: 'running' })]), [{ role: 'user', content: 'q' }]);
});

test('a real answer that also has a pending question is kept as the answer', () => {
  const reply = agent('Here is the draft. Shall I continue?', { bodySource: 'assistant', status: 'awaiting_approval', pendingInterrupt: { kind: 'approval' } });
  assert.equal(closingNoteFor(reply), null);
  assert.deepEqual(mapMessagesToAgentHistory([reply]), [{ role: 'assistant', content: 'Here is the draft. Shall I continue?' }]);
});

test('empty user messages are still skipped', () => {
  assert.deepEqual(mapMessagesToAgentHistory([user('   '), user('real')]), [{ role: 'user', content: 'real' }]);
});
