import assert from 'node:assert/strict';
import test from 'node:test';
import { composerQuery, insertReference, reconcileTokens } from '../src/components/chat/teamComposer.ts';

test('mention query uses caret rather than the end of the message', () => {
  assert.deepEqual(composerQuery('Review @Ka tomorrow', 10), { trigger: '@', query: 'ka', start: 7, end: 10 });
  assert.equal(composerQuery('email@example.com', 17), null);
  assert.deepEqual(composerQuery('/summ', 5), { trigger: '/', query: 'summ', start: 0, end: 5 });
});
test('selection replaces only the active mention and retains its identity', () => {
  const ref = { kind: 'person' as const, id: 'karl-2', label: 'Karl Chan' };
  const selected = insertReference('Review @Ka tomorrow', [], 7, 10, ref);
  assert.equal(selected.text, 'Review @Karl Chan  tomorrow');
  assert.equal(selected.tokens[0].reference.id, 'karl-2');
  assert.equal(selected.caret, 18);
});
test('editing a selected name removes its ID instead of notifying the old person', () => {
  const selected = insertReference('', [], 0, 0, { kind: 'person', id: 'karl', label: 'Karl Chan' });
  assert.deepEqual(reconcileTokens(selected.text, '@Karl Chen ', selected.tokens), []);
});
test('prefix insertion shifts references; removing a token preserves another identity', () => {
  const first = insertReference('', [], 0, 0, { kind: 'person', id: 'a', label: 'Alex' });
  const second = insertReference(first.text, first.tokens, first.text.length, first.text.length, { kind: 'person', id: 'b', label: 'Alex' });
  const shifted = reconcileTokens(second.text, 'Hi ' + second.text, second.tokens);
  assert.deepEqual(shifted.map((t) => t.reference.id), ['a', 'b']);
  assert.equal(shifted[0].start, 3);
  const removed = reconcileTokens(second.text, second.text.slice(first.tokens[0].end), second.tokens);
  assert.equal(removed.length, 1);
});
test('auto-adding Lumo preserves a teammate beginning with the same @ prefix', () => {
  const selected = insertReference('', [], 0, 0, { kind: 'person', id: 'karl', label: 'Karl Chan' });
  const agent = insertReference(selected.text, selected.tokens, 0, 0, { kind: 'agent', id: 'lumo', label: 'Lumo' });
  assert.equal(agent.text, '@Lumo @Karl Chan ');
  assert.deepEqual(agent.tokens.map((token) => token.reference.id), ['karl', 'lumo']);
  assert.equal(agent.tokens[0].start, 6);
});
