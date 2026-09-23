import { test } from 'node:test';
import assert from 'node:assert';

import { parseSharedChatDirective } from '../src/services/workspaceTeamChatAgentService';

/**
 * The agent parses `/skill` and `/mcp` itself, but only from the first non-empty
 * line of the text it receives. Shared Chat prepends its channel preamble, so a
 * directive a member typed never reached line one and was dropped without a
 * word. These pin the extraction that runs before the preamble is composed.
 */

test('a leading skill directive is lifted out of the question', () => {
  const { directive, question } = parseSharedChatDirective(
    '/skill research compare the two vendors',
  );
  assert.deepStrictEqual(directive, { kind: 'skill', skillId: 'research' });
  assert.strictEqual(question, 'compare the two vendors');
});

test('a leading mcp directive is lifted out of the question', () => {
  const { directive, question } = parseSharedChatDirective(
    '/mcp bigquery-managed list my datasets',
  );
  assert.deepStrictEqual(directive, { kind: 'mcp', serverId: 'bigquery-managed' });
  assert.strictEqual(question, 'list my datasets');
});

test('the rest of a multi-line message stays with the question', () => {
  const { directive, question } = parseSharedChatDirective(
    '/skill research\nfocus on pricing\nand on support terms',
  );
  assert.deepStrictEqual(directive, { kind: 'skill', skillId: 'research' });
  assert.strictEqual(question, 'focus on pricing\nand on support terms');
});

test('leading blank lines do not hide the directive', () => {
  const { directive } = parseSharedChatDirective('\n\n  /skill pptx build a deck');
  assert.deepStrictEqual(directive, { kind: 'skill', skillId: 'pptx' });
});

test('a directive further down the message is not honoured', () => {
  // Matches private chat: only a leading directive counts, so prose that merely
  // mentions a command cannot silently rebind the run.
  const { directive, question } = parseSharedChatDirective(
    'can you help\n/skill research',
  );
  assert.strictEqual(directive, null);
  assert.strictEqual(question, 'can you help\n/skill research');
});

test('an ordinary question is untouched', () => {
  const { directive, question } = parseSharedChatDirective('would you list the datasets?');
  assert.strictEqual(directive, null);
  assert.strictEqual(question, 'would you list the datasets?');
});
