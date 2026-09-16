import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJsonPayloads } from '../src/utils/extractJsonPayload.ts';

const parseActions = (text: string) => {
  for (const candidate of [...extractJsonPayloads(text), text.trim()]) {
    try {
      const parsed = JSON.parse(candidate);
      const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
      if (Array.isArray(actions) && actions.every((a: unknown) => {
        const entry = a as { type?: unknown } | null;
        return entry !== null && typeof entry === 'object' && typeof entry.type === 'string';
      })) {
        return actions;
      }
    } catch { /* prose while the creator is still asking */ }
  }
  return [];
};

test('a proposal whose SKILL.md contains a fenced block still parses', () => {
  // The case that broke it: the Creator documents how to run the script it is proposing,
  // so a ```bash fence lives inside a JSON string. A non-greedy fence regex ended there.
  const reply = [
    'Here is a complete proposal.',
    '',
    '```json',
    JSON.stringify({
      actions: [
        { type: 'create_skill', skillId: 'read-csv', name: 'Read CSV', description: 'Reads a CSV.' },
        {
          type: 'upsert_text',
          path: 'SKILL.md',
          content: '---\nname: Read CSV\n---\n\n## CLI Usage\n\n```bash\npython scripts/convert_csv.py file.csv --page 1\n```\n\n### Arguments\n- `file_path`\n',
        },
        { type: 'upsert_text', path: 'scripts/convert_csv.py', content: 'import csv\nprint("| a | b |")\n' },
      ],
    }, null, 2),
    '```',
  ].join('\n');

  const actions = parseActions(reply);
  assert.equal(actions.length, 3);
  assert.equal(actions[0].type, 'create_skill');
  assert.match(actions[1].content, /```bash/, 'the nested fence must survive intact');
  assert.match(actions[2].path, /^scripts\//);
});

test('prose while the creator is still asking yields nothing', () => {
  assert.deepEqual(parseActions('Do you have a specific weather API, or a mock?'), []);
});

test('a bare array is accepted', () => {
  assert.equal(parseActions('```json\n[{"type":"create_skill","skillId":"x"}]\n```').length, 1);
});

test('the last proposal wins when a reply revises an earlier one', () => {
  const reply = [
    '```json', '{"actions":[{"type":"create_skill","skillId":"first"}]}', '```',
    'On reflection:',
    '```json', '{"actions":[{"type":"create_skill","skillId":"second"}]}', '```',
  ].join('\n');
  assert.equal(parseActions(reply)[0].skillId, 'second');
});

test('braces inside strings do not end the value early', () => {
  const reply = '```json\n' + JSON.stringify({
    actions: [{ type: 'upsert_text', path: 'SKILL.md', content: 'use {"a": [1,2]} and a quote \\" here' }],
  }) + '\n```';
  assert.match(parseActions(reply)[0].content, /\{"a": \[1,2\]\}/);
});

// The two shapes the scanner cannot rescue: balanced, mentions `actions`, will not parse.
// They must be distinguishable from conversation so the dialog can say which happened.
const looksLikeAProposal = (text: string): boolean =>
  extractJsonPayloads(text).some((candidate) => candidate.includes('"actions"'));

test('a truncated proposal is reported, not silently empty', () => {
  const cut = '```json\n{"actions": [{"type": "upsert_text", "path": "SKILL.md", "content": "half a fi';
  assert.deepEqual(parseActions(cut), [], 'it cannot be parsed');
  assert.equal(looksLikeAProposal(cut), false, 'an unbalanced cut has no candidate at all');
});

test('a malformed but balanced proposal is distinguishable from conversation', () => {
  const bad = '```json\n{"actions": [{"type":"create_skill","skillId":"x"},]}\n```';
  assert.deepEqual(parseActions(bad), [], 'invalid JSON yields no actions');
  assert.equal(looksLikeAProposal(bad), true, 'but it is recognisably an attempted proposal');
  assert.equal(looksLikeAProposal('Which weather API should it call?'), false);
});

test('many files with nested fences and a decoy block parse cleanly', () => {
  const actions = [
    { type: 'create_skill', skillId: 'multi', name: 'Multi', description: 'many files' },
    { type: 'upsert_text', path: 'SKILL.md', content: '```bash\npython x.py\n```\n```python\nprint({"k": [1,2]})\n```\n' },
    { type: 'upsert_text', path: 'scripts/a.py', content: 'd = {"a": {"b": [1, 2]}}\n' },
    { type: 'upsert_text', path: 'references/g.md', content: 'quote " and \\ backslash\n```json\n{"decoy":{"actions":[]}}\n```\n' },
    { type: 'remove', path: 'old.md' },
  ];
  const reply = 'Proposal:\n\n```json\n' + JSON.stringify({ actions }, null, 2) + '\n```\n\nLet me know.';
  const got = parseActions(reply);
  assert.equal(got.length, 5);
  assert.match(got[3].content, /decoy/, 'a json block inside a string stays inside it');
});
