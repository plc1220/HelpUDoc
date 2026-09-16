import type { Parent, Root } from 'mdast';

/** Render Markdown's conventional <br> without enabling arbitrary raw HTML. */
export function remarkEditorHtml() {
  return (tree: Root): void => {
    const visit = (parent: Parent) => {
      parent.children = parent.children.map(node => {
        if (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value.trim())) {
          return { type: 'break', position: node.position };
        }
        if ('children' in node) visit(node);
        return node;
      });
    };
    visit(tree);
  };
}
