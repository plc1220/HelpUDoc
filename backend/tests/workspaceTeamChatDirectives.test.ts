import { test } from 'node:test';
import assert from 'node:assert';

import {
  parseKnowledgeBaseMentions,
  parseSharedChatDirective,
} from '../src/services/workspaceTeamChatAgentService';

/**
 * Shared Chat prepends its channel preamble, so a directive a member typed never
 * survives into the text the agent reads. These pin the extraction that runs
 * before the preamble is composed.
 *
 * The parser is shared with the private composer
 * (`packages/contracts/src/composerDirectives.ts`), so a directive is found
 * wherever it sits. Both surfaces used to accept a leading directive only, which
 * meant tagging a knowledge base first dropped the skill in either place.
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

test('a directive further down the message is honoured', () => {
  // The reported bug, in the shared channel: the `/` menu inserts at the cursor,
  // so a member who tagged a base first put the directive on line two and lost
  // the skill. Private chat now reads it too.
  const { directive, question } = parseSharedChatDirective(
    'can you help\n/skill research',
  );
  assert.deepStrictEqual(directive, { kind: 'skill', skillId: 'research' });
  assert.strictEqual(question, 'can you help');
});

test('a knowledge base tagged before the skill does not hide it', () => {
  const { directive, question } = parseSharedChatDirective(
    '@kb:General Knowledge /skill data/analyze summarise it',
  );
  assert.deepStrictEqual(directive, { kind: 'skill', skillId: 'data/analyze' });
  assert.strictEqual(question, '@kb:General Knowledge summarise it');
});

test('the knowledge base is still resolvable from the remaining question', () => {
  // The two tags have to survive together: the directive leaves, the mention
  // stays behind for `parseKnowledgeBaseMentions`.
  const { question } = parseSharedChatDirective('@kb:Sales Playbook /skill research go');
  assert.deepStrictEqual(parseKnowledgeBaseMentions(question), ['Sales Playbook go']);
});

test('prose that merely looks like a path does not rebind the run', () => {
  const { directive } = parseSharedChatDirective('see https://example.test/skill/data');
  assert.strictEqual(directive, null);
});

test('an ordinary question is untouched', () => {
  const { directive, question } = parseSharedChatDirective('would you list the datasets?');
  assert.strictEqual(directive, null);
  assert.strictEqual(question, 'would you list the datasets?');
});

test('a kb mention captures the rest of the line as a candidate', () => {
  // Over-long on purpose: a base name may contain spaces and nothing in the text
  // marks where it ends, so the resolver picks the longest real name.
  assert.deepStrictEqual(
    parseKnowledgeBaseMentions('check @kb:Sales Playbook for pricing'),
    ['Sales Playbook for pricing'],
  );
});

test('each mentioned line yields its own candidate', () => {
  assert.deepStrictEqual(
    parseKnowledgeBaseMentions('@kb:Security review\nthen @kb:Sales Playbook'),
    ['Security review', 'Sales Playbook'],
  );
});

test('an identical mention is collected once', () => {
  assert.deepStrictEqual(
    parseKnowledgeBaseMentions('@kb:Security\n@kb:Security'),
    ['Security'],
  );
});

test('no kb mention yields nothing', () => {
  assert.deepStrictEqual(parseKnowledgeBaseMentions('plain question about @someone'), []);
});

test('the boundary rule the resolver applies', () => {
  // Mirrors resolveKnowledgeBaseIdsByMention: longest real name that the typed
  // text equals or starts with, followed by a space.
  const names = ['sales', 'sales playbook'].sort((a, b) => b.length - a.length);
  const pick = (candidate: string) => names.find(
    (name) => candidate === name || candidate.startsWith(`${name} `),
  );
  assert.strictEqual(pick('sales playbook for pricing'), 'sales playbook');
  assert.strictEqual(pick('sales figures please'), 'sales');
  assert.strictEqual(pick('salesforce notes'), undefined, 'must not match a prefix mid-word');
});
