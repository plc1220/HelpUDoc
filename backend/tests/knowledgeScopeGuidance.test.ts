import assert from 'node:assert/strict';
import test from 'node:test';

import { formatKnowledgeScopeGuidance } from '../src/services/knowledgeScopeGuidance';

test('a tagged knowledge base is named above its documents', () => {
  const guidance = formatKnowledgeScopeGuidance([
    { id: 56, title: 'VLM Benchmark Project.md', knowledgeBaseName: 'WAF Rules Test', knowledgeBaseVersion: '0.3' },
    { id: 58, title: 'Rest of World.pdf', knowledgeBaseName: 'WAF Rules Test', knowledgeBaseVersion: '0.3' },
  ]);
  assert.equal(guidance, [
    'Tagged Knowledge bundles (the only Knowledge scope for this turn):',
    '- Knowledge base "WAF Rules Test" (version 0.3). When the user names this knowledge base, they mean these documents:',
    '  - VLM Benchmark Project.md (knowledge://56/index.md)',
    '  - Rest of World.pdf (knowledge://58/index.md)',
    'Use knowledge_read or knowledge_search only within these selected bundles.',
  ].join('\n'));
});

test('individually tagged documents keep the flat list', () => {
  const guidance = formatKnowledgeScopeGuidance([{ id: 7, title: 'Policy.pdf' }]);
  assert.equal(guidance, [
    'Tagged Knowledge bundles (the only Knowledge scope for this turn):',
    '- Policy.pdf (knowledge://7/index.md)',
    'Use knowledge_read or knowledge_search only within these selected bundles.',
  ].join('\n'));
});

test('bases and loose documents are listed separately', () => {
  const guidance = formatKnowledgeScopeGuidance([
    { id: 7, title: 'Policy.pdf' },
    { id: 9, title: 'Guide.md', knowledgeBaseName: 'Onboarding', knowledgeBaseVersion: null },
  ]);
  assert.match(guidance, /- Knowledge base "Onboarding"\. When the user names/);
  assert.match(guidance, /- Individually tagged documents:\n {2}- Policy\.pdf \(knowledge:\/\/7\/index\.md\)/);
});
