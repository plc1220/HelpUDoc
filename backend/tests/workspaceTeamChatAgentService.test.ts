import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAgentReplyText } from '../src/services/workspaceTeamChatAgentService';

test('extractAgentReplyText reads a direct ChatResponse reply', () => {
  assert.equal(extractAgentReplyText({ reply: 'Published answer' }), 'Published answer');
});

test('extractAgentReplyText selects the latest assistant message from agent state', () => {
  assert.equal(
    extractAgentReplyText({
      reply: {
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: [{ type: 'text', text: 'Read-only answer' }] },
        ],
      },
    }),
    'Read-only answer',
  );
});

test('extractAgentReplyText does not echo a user-only state', () => {
  assert.equal(
    extractAgentReplyText({
      reply: {
        messages: [{ role: 'user', content: 'Do not echo me' }],
      },
    }),
    '',
  );
});
