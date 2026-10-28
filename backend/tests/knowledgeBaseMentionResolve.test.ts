import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeService } from '../src/services/knowledgeService';
import { parseKnowledgeBaseMentions } from '../src/services/workspaceTeamChatAgentService';

const BASES = [
  { id: 'waf', name: 'WAF Test KB' },
  { id: 'sales', name: 'Sales' },
  { id: 'playbook', name: 'Sales Playbook' },
  { id: 'q4', name: 'Q4' },
];

const makeService = () => {
  const service = Object.create(KnowledgeService.prototype) as any;
  service.resolveAccessibleKnowledgeBaseIds = async () => null; // admin: every base
  const query: any = {
    where: () => query,
    select: () => query,
    whereIn: () => query,
    then: (resolve: (rows: typeof BASES) => unknown) => resolve(BASES),
  };
  service.db = () => query;
  return service as KnowledgeService;
};

// Shared Chat sends the over-long candidate after `@kb:`; the resolver decides
// where the name ends.
const resolve = (message: string) =>
  makeService().resolveKnowledgeBaseIdsByMention('user', parseKnowledgeBaseMentions(message));

test('Shared Chat accepts a mention that ends with punctuation', async () => {
  assert.deepEqual(await resolve('What is in @kb:WAF Test KB?'), ['waf']);
  assert.deepEqual(await resolve('Summarise @kb:WAF Test KB.'), ['waf']);
  assert.deepEqual(await resolve('@kb:WAF Test KB, then compare'), ['waf']);
});

test('Shared Chat still takes the longest name and needs a real end', async () => {
  assert.deepEqual(await resolve('check @kb:Sales Playbook? now'), ['playbook']);
  assert.deepEqual(await resolve('check @kb:Sales figures'), ['sales']);
  assert.deepEqual(await resolve('check @kb:Q4.1 numbers'), []);
  assert.deepEqual(await resolve('check @kb:Salesforce data'), []);
});
