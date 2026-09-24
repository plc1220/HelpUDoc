import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findKnowledgeBaseMentions,
  parseComposerDirective,
  removeComposerDirective,
} from '@helpudoc/contracts/composerDirectives';

/**
 * The reported bug: selecting a knowledge base before a skill dropped the skill.
 * `@` mentions were position-independent and `/` directives were not, so the
 * order of tagging decided whether the skill reached the agent at all.
 *
 * `tests/test_directives.py` runs the same vectors through the agent's copy.
 */

test('a skill is found after a knowledge base mention', () => {
  const directive = parseComposerDirective('@kb:General Knowledge /skill data/analyze');
  assert.equal(directive?.kind, 'skill');
  assert.equal(directive?.id, 'data/analyze');
  assert.equal(directive?.prompt, '@kb:General Knowledge');
});

test('a skill is still found when it comes first', () => {
  const directive = parseComposerDirective('/skill data/analyze @kb:General Knowledge summarise it');
  assert.equal(directive?.id, 'data/analyze');
  assert.equal(directive?.prompt, '@kb:General Knowledge summarise it');
});

test('a directive on a later line is found', () => {
  const directive = parseComposerDirective('@kb:General Knowledge\n/skill data/analyze');
  assert.equal(directive?.id, 'data/analyze');
  assert.equal(directive?.prompt, '@kb:General Knowledge');
});

test('a file mention before the skill does not hide it', () => {
  const directive = parseComposerDirective('@report.pdf /skill data/analyze');
  assert.equal(directive?.id, 'data/analyze');
  assert.equal(directive?.prompt, '@report.pdf');
});

test('the words either side of a mid-sentence directive stay apart', () => {
  const directive = parseComposerDirective('read @report.pdf /skill data/analyze then summarise');
  assert.equal(directive?.prompt, 'read @report.pdf then summarise');
});

test('an mcp directive is found the same way', () => {
  const directive = parseComposerDirective('@kb:Policies /mcp google-workspace find the invoice');
  assert.equal(directive?.kind, 'mcp');
  assert.equal(directive?.id, 'google-workspace');
  assert.equal(directive?.prompt, '@kb:Policies find the invoice');
});

test('a use or please-use lead-in goes with the directive', () => {
  // It addresses the product, not the request, so leaving it behind would hand
  // the model a sentence starting "Please use".
  assert.equal(parseComposerDirective('Use /skill proposal-writing draft a proposal')?.prompt, 'draft a proposal');
  assert.equal(parseComposerDirective('please use /skill data/analyze now')?.prompt, 'now');
  assert.equal(parseComposerDirective('we use /skill data/analyze here')?.prompt, 'we here');
});

test('a url path is not a directive', () => {
  assert.equal(parseComposerDirective('see https://example.test/skill/data for details'), null);
});

test('a file path is not a directive', () => {
  assert.equal(parseComposerDirective('look at docs/skill notes.md'), null);
});

test('a bare command with no target is not a directive', () => {
  assert.equal(parseComposerDirective('/skill'), null);
  assert.equal(parseComposerDirective('/skill   '), null);
});

test('the first directive wins, because a turn carries one', () => {
  const directive = parseComposerDirective('/skill data/analyze and /skill research');
  assert.equal(directive?.id, 'data/analyze');
});

test('a directive inside a bracket is found', () => {
  const directive = parseComposerDirective('(/skill data/analyze) go');
  assert.equal(directive?.id, 'data/analyze');
  assert.equal(directive?.prompt, '() go');
});

test('removing a directive leaves the rest of the message intact', () => {
  const message = '@kb:General Knowledge /skill data/analyze summarise it';
  const directive = parseComposerDirective(message);
  assert.ok(directive);
  assert.equal(
    removeComposerDirective(message, directive),
    '@kb:General Knowledge summarise it',
  );
});

test('a knowledge base is matched wherever it appears', () => {
  const bases = [{ id: 'a', name: 'General Knowledge' }];
  assert.deepEqual(findKnowledgeBaseMentions('@kb:General Knowledge /skill x', bases), bases);
  assert.deepEqual(findKnowledgeBaseMentions('/skill x @kb:General Knowledge', bases), bases);
});

test('the longest matching base name wins', () => {
  const bases = [{ id: 'short', name: 'General' }, { id: 'long', name: 'General Knowledge' }];
  const matched = findKnowledgeBaseMentions('@kb:General Knowledge please', bases);
  assert.equal(matched[0]?.id, 'long');
});

test('a base name that is not mentioned is not matched', () => {
  const bases = [{ id: 'a', name: 'Policies' }];
  assert.deepEqual(findKnowledgeBaseMentions('@kb:General Knowledge', bases), []);
});
