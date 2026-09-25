import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationMessage } from '../src/types.ts';
import { isAgentRunInFlight, isAwaitingUserInput, stopInFlightAgentMessages } from '../src/utils/messages.ts';

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

/**
 * `isAgentRunInFlight` decides whether the composer offers Stop. It has the
 * same scope rule as `isAwaitingUserInput` and for a sharper reason: a bubble
 * is reliably left at `running` when a newer stream supersedes an older one,
 * because the older stream skips its own status update to avoid clobbering the
 * newer turn. Under a whole-conversation scan that one bubble pinned Stop on
 * for the life of the conversation, naming a run that no longer existed.
 */

test('a running latest turn is in flight', () => {
  assert.equal(isAgentRunInFlight([agent({ status: 'running' })]), true);
});

test('a stale running turn behind a finished one is not in flight', () => {
  // The reported bug: Stop stayed on screen and pressing it did nothing.
  const messages = [agent({ status: 'running' }), user(), agent({ status: 'completed' })];
  assert.equal(isAgentRunInFlight(messages), false);
});

test('a local notice does not end a run that is still going', () => {
  assert.equal(isAgentRunInFlight([agent({ status: 'running' }), agent(null)]), true);
});

test('awaiting input is not in flight, so Stop gives way to Send', () => {
  assert.equal(isAgentRunInFlight([agent({ status: 'awaiting_approval' })]), false);
  assert.equal(isAgentRunInFlight([]), false);
});

test('stopping settles a running turn and drops its interrupt', () => {
  const [settled] = stopInFlightAgentMessages([agent({ status: 'running', runId: 'r1' })]);
  assert.equal(settled.metadata?.status, 'cancelled');
  assert.equal(settled.metadata?.pendingInterrupt, undefined);
  assert.equal(settled.metadata?.runId, 'r1', 'the run id survives, so the bubble stays attributable');
});

test('stopping settles an unanswered question too', () => {
  const [settled] = stopInFlightAgentMessages([agent({ pendingInterrupt: { kind: 'clarification' } })]);
  assert.equal(settled.metadata?.status, 'cancelled');
  assert.equal(settled.metadata?.pendingInterrupt, undefined);
});

test('stopping leaves finished turns and user messages alone', () => {
  const messages = [user(), agent({ status: 'completed', runActiveMs: 1200 }), agent(null)];
  const settled = stopInFlightAgentMessages(messages);
  assert.equal(settled[0].sender, 'user');
  assert.equal(settled[1].metadata?.status, 'completed');
  assert.equal(settled[1].metadata?.runActiveMs, 1200, 'a finished run keeps its timing');
  assert.equal(settled[2].metadata, null);
});

test('stopping a conversation with nothing live changes no statuses', () => {
  const messages = [agent({ status: 'completed' })];
  const settled = stopInFlightAgentMessages(messages);
  assert.deepEqual(settled.map((m) => m.metadata?.status), ['completed']);
});

test('stopping clears every live bubble, not just the newest', () => {
  // Stop is a statement about the screen: nothing should still be spinning.
  const settled = stopInFlightAgentMessages([
    agent({ status: 'running', runId: 'old' }),
    user(),
    agent({ status: 'running', runId: 'new' }),
  ]);
  assert.deepEqual(
    settled.filter((m) => m.sender === 'agent').map((m) => m.metadata?.status),
    ['cancelled', 'cancelled'],
  );
});
