import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayedKnowledgeBaseIds,
  grantIdsFromSelection,
  ownedKnowledgeBaseIds,
  teamKnowledgeOptions,
} from '../src/utils/teamKnowledgeAccess.ts';

const bases = [
  { id: 'own', name: 'WAF Rules Test', status: 'published', ownerTeamId: 'team-a' },
  { id: 'other', name: 'Policies', status: 'published', ownerTeamId: 'team-b' },
  { id: 'draft', name: 'Draft base', status: 'draft', ownerTeamId: 'team-a' },
];

test('a team owns only its published bases', () => {
  assert.deepEqual(ownedKnowledgeBaseIds(bases, 'team-a'), ['own']);
  assert.deepEqual(ownedKnowledgeBaseIds(bases, ''), []);
});

test('owned bases are shown ticked and locked', () => {
  assert.deepEqual(teamKnowledgeOptions(bases, 'team-a'), [
    { value: 'own', label: 'WAF Rules Test (owned by this team)', disabled: true },
    { value: 'other', label: 'Policies' },
  ]);
  assert.deepEqual(displayedKnowledgeBaseIds(['other'], ['own']), ['other', 'own']);
});

test('selecting never writes a grant for an owned base', () => {
  assert.deepEqual(grantIdsFromSelection(['own', 'other'], [], ['own']), ['other']);
});

test('an existing grant on an owned base is left as it was', () => {
  assert.deepEqual(grantIdsFromSelection([], ['own', 'other'], ['own']), ['own']);
});
