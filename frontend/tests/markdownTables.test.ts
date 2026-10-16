import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

import remarkBreakTags from '../src/components/markdown/remarkBreakTags.ts';
import {
  WRAPPING_CELL_MIN_CHARS,
  cellTextLength,
  shouldWrapTableCell,
} from '../src/components/markdown/tableCells.ts';

type Node = { type: string; value?: string; children?: Node[] };

const parse = (markdown: string): Node => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreakTags);
  return processor.runSync(processor.parse(markdown)) as Node;
};

const firstBodyCell = (tree: Node): Node => tree.children![0].children![1].children![1];

test('a <br> in a table cell becomes a line break', () => {
  const tree = parse('| Sector | Activities |\n|---|---|\n| Credit | • BNPL<br>• Leasing<br/>• Pawn<BR /> |\n');
  assert.deepEqual(
    firstBodyCell(tree).children!.map((node) => node.type),
    ['text', 'break', 'text', 'break', 'text', 'break'],
  );
});

test('other raw HTML is left as it was', () => {
  const tree = parse('| A | B |\n|---|---|\n| x | <b>bold</b><script>x</script> |\n');
  const types = firstBodyCell(tree).children!.map((node) => node.type);
  assert.ok(!types.includes('break'));
  assert.ok(types.includes('html'));
});

test('a <br> inside code stays literal', () => {
  const tree = parse('Use `<br>` here.\n\n```\n<br>\n```\n');
  const paragraph = tree.children![0];
  assert.deepEqual(paragraph.children!.map((node) => node.type), ['text', 'inlineCode', 'text']);
  assert.equal(paragraph.children![1].value, '<br>');
  assert.equal(tree.children![1].type, 'code');
});

test('cell text length counts text inside nested elements', () => {
  const cell = ['Consumer ', createElement('strong', null, 'Credit'), ' Act ', createElement('em', null, ['(', 'Act 873', ')'])];
  assert.equal(cellTextLength(cell), 'Consumer Credit Act (Act 873)'.length);
});

test('short values stay on one line and prose wraps', () => {
  for (const value of ['2026-01-01 00:00:00', 'RM 1,200.00', 'Kuala Lumpur', 'Official Act Name']) {
    assert.equal(shouldWrapTableCell(value), false, value);
  }
  assert.equal(
    shouldWrapTableCell('Obligates credit providers to perform standardized affordability assessments.'),
    true,
  );
  assert.equal(shouldWrapTableCell('x'.repeat(WRAPPING_CELL_MIN_CHARS)), false);
  assert.equal(shouldWrapTableCell('x'.repeat(WRAPPING_CELL_MIN_CHARS + 1)), true);
});
