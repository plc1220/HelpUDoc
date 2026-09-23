import { test } from 'node:test';
import assert from 'node:assert';

import { extractAgentReplyText } from '../src/services/workspaceTeamChatAgentService';

/**
 * Shared Chat answers through the non-streaming `/chat` endpoint, which returns
 * the whole agent state. `_prepare_payload` seeds that state with the `history`
 * the service sends, so the message list holds earlier assistant replies beside
 * this turn's. Scanning it backwards without a boundary returned a previous
 * answer whenever the current turn produced no text of its own, and a tester was
 * shown a summary of a PDF in reply to a question about BigQuery datasets.
 */

const PRIOR_REPLY =
  'I have successfully created and saved the comprehensive summary of the '
  + 'Grab/foodpanda Taiwan acquisition as a text file in your workspace: '
  + '/Grab_foodpanda_Acquisition_Summary.txt';

const stateWithHistory = (currentTurn: Array<Record<string, unknown>>) => ({
  reply: {
    messages: [
      { type: 'human', content: 'cm_tester10: summarise the Grab/foodpanda PDF' },
      { type: 'ai', content: PRIOR_REPLY },
      { type: 'human', content: 'Question from cm_tester10: can you see the bigquery dataset?' },
      ...currentTurn,
    ],
  },
});

test('a turn that produces no text does not replay the previous answer', () => {
  // The turn stopped on a tool call, so its assistant message carries no text.
  const reply = extractAgentReplyText(stateWithHistory([
    { type: 'ai', content: '', tool_calls: [{ name: 'list_dataset_ids', args: {} }] },
  ]));

  assert.strictEqual(reply, '', 'must not reach back past the current question');
});

test('a turn with no assistant message at all returns nothing', () => {
  assert.strictEqual(extractAgentReplyText(stateWithHistory([])), '');
});

test('the current turn answer is returned when there is one', () => {
  const reply = extractAgentReplyText(stateWithHistory([
    { type: 'ai', content: '', tool_calls: [{ name: 'list_dataset_ids', args: {} }] },
    { type: 'tool', content: 'permission denied' },
    { type: 'ai', content: 'I cannot reach BigQuery from the shared channel.' },
  ]));

  assert.strictEqual(reply, 'I cannot reach BigQuery from the shared channel.');
});

test('the newest assistant message wins within one turn', () => {
  const reply = extractAgentReplyText(stateWithHistory([
    { type: 'ai', content: 'Let me check.' },
    { type: 'tool', content: 'ok' },
    { type: 'ai', content: 'Here are the datasets.' },
  ]));

  assert.strictEqual(reply, 'Here are the datasets.');
});

test('a first turn with no history still answers', () => {
  const reply = extractAgentReplyText({
    reply: {
      messages: [
        { type: 'human', content: 'Question from cm_tester10: hello' },
        { type: 'ai', content: 'Hello.' },
      ],
    },
  });

  assert.strictEqual(reply, 'Hello.');
});

test('a plain string reply is unchanged', () => {
  assert.strictEqual(extractAgentReplyText({ reply: '  done  ' }), 'done');
});

test('block content is joined', () => {
  const reply = extractAgentReplyText(stateWithHistory([
    { type: 'ai', content: [{ type: 'text', text: 'Dataset A' }, { type: 'text', text: 'Dataset B' }] },
  ]));

  assert.strictEqual(reply, 'Dataset A\nDataset B');
});
