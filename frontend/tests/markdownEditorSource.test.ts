import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMarkdownForRichEditor } from '../src/utils/markdownEditorSource.ts';

test('normalizes HTML line breaks in multiple GFM tables without changing structure', () => {
  const source = '| Name | Scope |\n| --- | --- |\n| A | First<br>Second<BR >Third |\n\n| Fee | Notes |\n| --- | --- |\n| 20 | Tax<br/>Included<br />Already |';
  assert.equal(prepareMarkdownForRichEditor(source), source.replace('<br>', '<br />').replace('<BR >', '<BR />'));
});

test('preserves fenced and indented code, inline code, and escaped HTML', () => {
  const source = '```html\n<br>\n<img src="sample.png">\n```\n\n~~~md\n| A<br>B |\n~~~\n\n    <br>\n\nUse `<br>` or ``<img src="x">`` and \\<br>.\n\nReal<br>break.';
  assert.equal(prepareMarkdownForRichEditor(source), source.replace('Real<br>break.', 'Real<br />break.'));
});

test('handles quoted angle brackets, all void tags, comments and raw HTML blocks', () => {
  const source = '<div>\n<img alt="a > b" src="photo.png">\n<hr><input disabled><source src="a"><wbr>\n<!-- example <br> -->\n</div>';
  const expected = '<div>\n<img alt="a > b" src="photo.png" />\n<hr /><input disabled /><source src="a" /><wbr />\n<!-- example <br> -->\n</div>';
  assert.equal(prepareMarkdownForRichEditor(source), expected);
});

test('leaves raw-text HTML contents and nonvoid tags unchanged', () => {
  const source = '<script>const tag = "<br>";</script>\n\n<style>.x::after { content: "<br>"; }</style>\n\n<textarea><br></textarea>\n\n<details><summary>Show</summary>Content</details>';
  assert.equal(prepareMarkdownForRichEditor(source), source);
});

test('does not rewrite HTML inside link destinations or titles', () => {
  const source = '[Example](https://example.com/ "Use <br>") and ![<br>](image.png "<br>")\n\n<https://example.com/br>\n';
  assert.equal(prepareMarkdownForRichEditor(source), source);
});

test('normalization is idempotent and preserves CRLF and surrounding whitespace', () => {
  const source = '\r\nParagraph<br>next\r\n\r\n';
  const normalized = prepareMarkdownForRichEditor(source);
  assert.equal(normalized, '\r\nParagraph<br />next\r\n\r\n');
  assert.equal(prepareMarkdownForRichEditor(normalized), normalized);
});
