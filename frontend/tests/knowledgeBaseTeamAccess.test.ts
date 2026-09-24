import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isKnowledgeBaseUsable,
  knowledgeBaseTeamAccessCount,
} from '../src/utils/knowledgeBaseTeamAccess.ts';

/**
 * Team Leads reported that a knowledge base they had just created showed no
 * team. It had one — its owning team, which reaches the base through
 * `ownerTeamId` and never gets a grant row. The panel counted grant rows alone.
 */

test('the owning team counts, even with no grants', () => {
  assert.equal(knowledgeBaseTeamAccessCount({ ownerTeamId: 'team-1' }, 0), 1);
});

test('granted teams are counted alongside the owner', () => {
  assert.equal(knowledgeBaseTeamAccessCount({ ownerTeamId: 'team-1' }, 2), 3);
});

test('a platform base with no owning team counts only its grants', () => {
  // The default base is owned by nobody and reaches teams purely by grant.
  assert.equal(knowledgeBaseTeamAccessCount({ ownerTeamId: null }, 3), 3);
  assert.equal(knowledgeBaseTeamAccessCount({ ownerTeamId: undefined }, 0), 0);
});

test('a draft is not usable, whoever it is shared with', () => {
  // Sharing and publishing are different steps, and only the second one makes
  // the base reachable from chat.
  assert.equal(isKnowledgeBaseUsable({ status: 'draft' }), false);
  assert.equal(isKnowledgeBaseUsable({ status: 'archived' }), false);
  assert.equal(isKnowledgeBaseUsable({ status: 'published' }), true);
});
