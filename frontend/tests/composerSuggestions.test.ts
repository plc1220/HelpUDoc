import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommandSuggestions,
  buildMentionSuggestions,
} from '../src/components/chat/composerSuggestions.ts';

/**
 * One implementation feeds both composers, so these pin what each menu offers.
 * The shared channel differs in exactly one way: it is given no connections.
 */

const FILES = [
  { id: 1, name: 'pricing.xlsx', mimeType: 'application/vnd.ms-excel' },
  { id: 2, name: 'notes.md', mimeType: null },
];

const BASES = [
  { id: 'kb-1', name: 'Sales Playbook', status: 'published', entitled: true },
  { id: 'kb-2', name: 'Security', status: 'published', entitled: true },
  { id: 'kb-3', name: 'Draft Base', status: 'draft', entitled: true },
  { id: 'kb-4', name: 'Not Mine', status: 'published', entitled: false },
];

const SKILLS = [
  { id: 'research', name: 'Research', description: 'Sourced report' },
  { id: 'pptx', name: 'Slides', description: 'Build a deck' },
];

const PLUGINS = [
  { id: 'data-analytics', displayName: 'Data Analytics', defaultSkillId: 'data' },
];

const MCP = [{ name: 'bigquery-managed', description: 'BigQuery' }];

test('the @ menu offers files and entitled published bases', () => {
  const rows = buildMentionSuggestions({ query: '', files: FILES, knowledgeBases: BASES });
  const names = rows.map((row) => row.name);

  assert.deepEqual(names, ['Sales Playbook', 'Security', 'pricing.xlsx', 'notes.md']);
  assert.ok(!names.includes('Draft Base'), 'an unpublished base is not usable');
  assert.ok(!names.includes('Not Mine'), 'a base the person is not entitled to is not offered');
});

test('a base row inserts the kb: prefix the agent parses', () => {
  const [first] = buildMentionSuggestions({ query: 'sales', files: FILES, knowledgeBases: BASES });
  assert.equal(first.mention, '@kb:Sales Playbook');
  assert.equal(first.kind, 'knowledgeBase');
});

test('a kb: query searches bases only', () => {
  const rows = buildMentionSuggestions({ query: 'kb:', files: FILES, knowledgeBases: BASES });
  assert.deepEqual(rows.map((row) => row.kind), ['knowledgeBase', 'knowledgeBase']);
});

test('a null mimeType does not break the file detail', () => {
  const rows = buildMentionSuggestions({ query: 'notes', files: FILES, knowledgeBases: [] });
  assert.equal(rows[0].detail, 'md');
});

test('nothing is truncated', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `kb-${index}`,
    name: `Base ${index}`,
    status: 'published',
    entitled: true,
  }));
  const rows = buildMentionSuggestions({ query: '', files: [], knowledgeBases: many });
  assert.equal(rows.length, 40, 'a short cap hid entitlements from whoever had the most');
});

test('the / menu offers skills and plugins, and connections when given them', () => {
  const rows = buildCommandSuggestions({
    query: '', skills: SKILLS, plugins: PLUGINS, mcpServers: MCP,
  });
  const inserted = rows.map((row) => row.insertCommand);

  assert.ok(inserted.includes('/skill research'));
  assert.ok(inserted.includes('/skill data'), 'a plugin inserts its default skill');
  assert.ok(inserted.includes('/mcp bigquery-managed'));
});

test('Shared Chat is given no connections, so none can be offered', () => {
  // The shared channel puts every configured server in `mcpServerDenyIds`, so a
  // `/mcp` row there would bind a run to tools that channel refuses.
  const rows = buildCommandSuggestions({
    query: '', skills: SKILLS, plugins: PLUGINS, mcpServers: [],
  });

  assert.ok(rows.every((row) => !(row.insertCommand || '').startsWith('/mcp')));
  assert.ok(rows.some((row) => row.insertCommand === '/skill research'), 'skills still offered');
});

test('a /mcp query returns nothing when there are no connections', () => {
  const rows = buildCommandSuggestions({
    query: 'mcp', skills: SKILLS, plugins: PLUGINS, mcpServers: [],
  });
  assert.deepEqual(rows, []);
});

test('a free-text query ranks matching skills', () => {
  const rows = buildCommandSuggestions({
    query: 'resea', skills: SKILLS, plugins: PLUGINS, mcpServers: [],
  });
  assert.equal(rows[0].insertCommand, '/skill research');
});
