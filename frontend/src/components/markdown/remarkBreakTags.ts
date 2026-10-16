type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const BREAK_TAG = /^<br\s*\/?>$/i;

/**
 * Turn a raw `<br>` into a Markdown line break.
 *
 * A GFM table row cannot hold a newline, so models write `<br>` inside cells to
 * list several items. Raw HTML stays off in every renderer, which is right, so the
 * tag used to show as literal text. Only the exact tag is converted: any other HTML
 * is left as it was, and a `<br>` inside code is a `code` node, not `html`, so it
 * stays literal.
 */
export default function remarkBreakTags() {
  const convert = (node: MarkdownNode) => {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.type === 'html' && BREAK_TAG.test((child.value || '').trim())) {
        child.type = 'break';
        delete child.value;
      } else {
        convert(child);
      }
    }
  };
  return (tree: MarkdownNode) => convert(tree);
}
