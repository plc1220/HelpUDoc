import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// MDXEditor parses HTML as JSX. Normalize actual Markdown HTML nodes only:
// regexes over the entire document would also rewrite code examples and escapes.
function normalizeHtmlFragment(html: string): string {
  const tokens = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(script|style|textarea|title)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>|<([a-z][a-z\d-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  return html.replace(tokens, (tag: string, _rawTextTag: string | undefined, name: string | undefined) => {
    if (!name || !VOID_TAGS.has(name.toLowerCase()) || /\/\s*>$/.test(tag)) return tag;
    return `${tag.slice(0, -1).trimEnd()} />`;
  });
}

export function prepareMarkdownForRichEditor(markdown: string): string {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const replacements: { start: number; end: number; value: string }[] = [];
  const visit = (node: typeof tree | typeof tree.children[number]) => {
    if (node.type === 'html' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const start = node.position.start.offset;
      const end = node.position.end.offset;
      const original = markdown.slice(start, end);
      const value = normalizeHtmlFragment(original);
      if (value !== original) replacements.push({ start, end, value });
    }
    if ('children' in node) node.children.forEach(child => visit(child as typeof tree.children[number]));
  };
  visit(tree);
  let result = markdown;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return result;
}
