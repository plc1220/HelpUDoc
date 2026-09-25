import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationMessage } from '../src/types.ts';
import { isAwaitingUserInput } from '../src/utils/messages.ts';

/**
 * The Stop button is hidden while the agent is waiting on the user, because
 * answering is the thing to do rather than stopping. That made the scope of
 * "is it waiting" load-bearing: asking it of the whole conversation meant one
 * question the user walked past hid Stop for every later run, permanently,
 * since the clearing path runs only when an interrupt is answered on its card.
 */

let nextId = 1;
const agent = (metadata: Record<string, unknown> | null): ConversationMessage => ({
  id: nextId++,
  sender: 'agent',
  text: 'agent turn',
  metadata,
} as unknown as ConversationMessage);

const user = (): ConversationMessage => ({
  id: nextId++,
  sender: 'user',
  text: 'user turn',
  metadata: null,
} as unknown as ConversationMessage);

test('a pending interrupt on the latest agent message is awaiting', () => {
  assert.equal(isAwaitingUserInput([agent({ pendingInterrupt: { kind: 'clarification' } })]), true);
});

test('an awaiting_approval status on the latest agent message is awaiting', () => {
  assert.equal(isAwaitingUserInput([agent({ status: 'awaiting_approval' })]), true);
});

test('a running latest message is not awaiting, whatever came before it', () => {
  // The reported bug: an unanswered question earlier in the conversation kept
  // Stop hidden for every run after it.
  const messages = [
    agent({ status: 'awaiting_approval', pendingInterrupt: { kind: 'clarification' } }),
    user(),
    agent({ status: 'running' }),
  ];
  assert.equal(isAwaitingUserInput(messages), false);
});

test('a completed latest message is not awaiting', () => {
  assert.equal(isAwaitingUserInput([agent({ pendingInterrupt: {} }), user(), agent({ status: 'completed' })]), false);
});

test('user messages after the agent do not change the answer', () => {
  // The user typing does not resolve the question; only a later agent turn does.
  assert.equal(isAwaitingUserInput([agent({ status: 'awaiting_approval' }), user()]), true);
});

test('an empty or agent-free conversation is not awaiting', () => {
  assert.equal(isAwaitingUserInput([]), false);
  assert.equal(isAwaitingUserInput([user(), user()]), false);
});

test('a latest agent message with no metadata is not awaiting', () => {
  assert.equal(isAwaitingUserInput([agent(null)]), false);
  assert.equal(isAwaitingUserInput([agent({})]), false);
});

test('a local notice does not mask the question it is complaining about', () => {
  // `addLocalSystemMessage` posts with sender 'agent' and no metadata, often
  // while an interrupt is still open — a failed decision submission being the
  // case that matters most.
  const messages = [agent({ status: 'awaiting_approval' }), agent(null)];
  assert.equal(isAwaitingUserInput(messages), true);
});

test('a real turn after a notice still decides', () => {
  const messages = [agent({ status: 'awaiting_approval' }), agent(null), agent({ status: 'running' })];
  assert.equal(isAwaitingUserInput(messages), false);
});
