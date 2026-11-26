import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConversationArchive } from '../src/services/conversationCompaction';

const longHistory = (turns: number) => Array.from({ length: turns }, (_, n) => ([
  { role: 'user', content: `QUESTION-${n} ${'w '.repeat(100)}` },
  { role: 'assistant', content: `ANSWER-${n} ${'w '.repeat(7000)}` },
])).flat();

test('the first message of an 800k-token chat is in the archive', () => {
  const rows = longHistory(230).map((entry, id) => ({
    id, sender: entry.role === 'user' ? 'user' : 'agent', text: entry.content, createdAt: new Date(0),
  }));
  const archive = buildConversationArchive('c', rows);
  assert.ok(archive);
  assert.equal(archive.truncated, false);
  assert.match(archive.messages[0].content, /QUESTION-0 /);
});
