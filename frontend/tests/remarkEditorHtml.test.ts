import assert from 'node:assert/strict';
import test from 'node:test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { remarkEditorHtml } from '../src/utils/remarkEditorHtml.ts';

test('renders conventional HTML breaks inside GFM tables as line breaks', () => {
  const tree = fromMarkdown('| Scope |\n| --- |\n| First<br>Second<BR />Third |', { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  remarkEditorHtml()(tree);
  const table = tree.children[0];
  assert.equal(table.type, 'table');
  if (table.type !== 'table') throw new Error('Expected table');
  assert.deepEqual(table.children[1].children[0].children.map(node => node.type), ['text', 'break', 'text', 'break', 'text']);
});

test('leaves inline/fenced code, arbitrary HTML, and HTML event attributes inert', () => {
  const source = 'Use `<br>`.\n\n```html\n<br>\n```\n\n<script>alert(1)</script>\n\n<br onclick="alert(1)">\n\n<img src="x" onerror="alert(1)">';
  const tree = fromMarkdown(source);
  const before = JSON.stringify(tree);
  remarkEditorHtml()(tree);
  assert.equal(JSON.stringify(tree), before);
});
