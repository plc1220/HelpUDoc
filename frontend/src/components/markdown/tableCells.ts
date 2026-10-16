import { Children, isValidElement, type ReactNode } from 'react';

/**
 * A table cell longer than this wraps; a shorter one stays on one line.
 *
 * Query output (dates, amounts, place names) needs one line per value, or
 * `2026-01-01 00:00:00` and `RM 1,200.00` split across two. A cell of prose needs to
 * wrap, or the table runs as wide as its longest sentence. 40 characters sits
 * between the two: well above a timestamp or an amount, below a short sentence.
 */
export const WRAPPING_CELL_MIN_CHARS = 40;

/** The number of text characters a rendered Markdown cell holds. */
export const cellTextLength = (node: ReactNode): number => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).length;
  }
  if (Array.isArray(node)) {
    return node.reduce((total: number, child: ReactNode) => total + cellTextLength(child), 0);
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return Children.toArray(node.props.children)
      .reduce((total: number, child) => total + cellTextLength(child), 0);
  }
  return 0;
};

export const shouldWrapTableCell = (children: ReactNode): boolean =>
  cellTextLength(children) > WRAPPING_CELL_MIN_CHARS;
