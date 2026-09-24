import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isKnowledgeBaseUsable,
  knowledgeBaseTeamAccessCount,
  selectVisibleKnowledgeBases,
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

/**
 * Drafts are hidden from the Catalog tab: a base nobody can reference is not a
 * thing to browse. My knowledge bases keeps them, or a Team Lead has nowhere to
 * open the base they just created and publish it.
 */

const base = (over: Partial<Parameters<typeof selectVisibleKnowledgeBases>[0]['bases'][number]> = {}) => ({
  name: 'Analyst Library',
  slug: 'knowledge/analyst-library',
  status: 'published' as const,
  ownerTeamId: 'team-1',
  ownerTeamName: 'Analysts',
  ...over,
});

test('the catalog lists published bases and hides drafts', () => {
  const visible = selectVisibleKnowledgeBases({
    bases: [base(), base({ name: 'Draft Library', status: 'draft' })],
    tab: 'catalog',
    ledTeamIds: ['team-1'],
  });
  assert.deepEqual(visible.map((entry) => entry.name), ['Analyst Library']);
});

test('my knowledge bases keeps a draft, which is where it gets published', () => {
  const visible = selectVisibleKnowledgeBases({
    bases: [base(), base({ name: 'Draft Library', status: 'draft' })],
    tab: 'manage',
    ledTeamIds: ['team-1'],
  });
  assert.deepEqual(visible.map((entry) => entry.name), ['Analyst Library', 'Draft Library']);
});

test('my knowledge bases shows only teams the user leads', () => {
  const visible = selectVisibleKnowledgeBases({
    bases: [base(), base({ name: 'Other Team Library', ownerTeamId: 'team-2' })],
    tab: 'manage',
    ledTeamIds: ['team-1'],
  });
  assert.deepEqual(visible.map((entry) => entry.name), ['Analyst Library']);
});

test('the search applies after the tab has scoped the list', () => {
  // A draft matching the query still must not appear in the catalog.
  const visible = selectVisibleKnowledgeBases({
    bases: [base({ name: 'Draft Library', status: 'draft' })],
    tab: 'catalog',
    ledTeamIds: ['team-1'],
    query: 'draft',
  });
  assert.deepEqual(visible, []);
});

test('the search matches name, slug or owning team', () => {
  const bases = [base(), base({ name: 'Policies', slug: 'knowledge/policies', ownerTeamName: 'Legal' })];
  const byName = selectVisibleKnowledgeBases({ bases, tab: 'catalog', ledTeamIds: [], query: 'analyst' });
  const bySlug = selectVisibleKnowledgeBases({ bases, tab: 'catalog', ledTeamIds: [], query: 'policies' });
  const byTeam = selectVisibleKnowledgeBases({ bases, tab: 'catalog', ledTeamIds: [], query: 'legal' });
  assert.deepEqual(byName.map((e) => e.name), ['Analyst Library']);
  assert.deepEqual(bySlug.map((e) => e.name), ['Policies']);
  assert.deepEqual(byTeam.map((e) => e.name), ['Policies']);
});
