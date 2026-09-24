import type { IconKey } from '@mdxeditor/editor';
import {
  Undo2, Redo2, Bold, Italic, Underline, Code, Strikethrough, Superscript, Subscript,
  List, ListOrdered, ListTodo, Highlighter, Link, ImagePlus, Table, Minus, FileCode2,
  ChevronDown, Info, Box, FileText, GitCompare, ExternalLink, Unlink, Pencil, Copy,
  MoreHorizontal, MoreVertical, X, Settings, Trash2, AlignCenter, AlignLeft, AlignRight,
  Rows3, Columns3, ArrowLeftToLine, ArrowUpToLine, ArrowDownToLine, ArrowRightToLine,
  Check, type LucideIcon,
} from 'lucide-react';

const icons: Record<IconKey, LucideIcon> = {
  undo: Undo2, redo: Redo2, format_bold: Bold, format_italic: Italic, format_underlined: Underline,
  code: Code, strikeThrough: Strikethrough, superscript: Superscript, subscript: Subscript,
  format_list_bulleted: List, format_list_numbered: ListOrdered, format_list_checked: ListTodo,
  format_highlight: Highlighter, link: Link, add_photo: ImagePlus, table: Table, horizontal_rule: Minus,
  frontmatter: FileCode2, frame_source: FileCode2, arrow_drop_down: ChevronDown, admonition: Info,
  sandpack: Box, rich_text: FileText, difference: GitCompare, markdown: FileCode2, open_in_new: ExternalLink,
  link_off: Unlink, edit: Pencil, content_copy: Copy, more_horiz: MoreHorizontal, more_vert: MoreVertical,
  close: X, settings: Settings, delete_big: Trash2, delete_small: Trash2,
  format_align_center: AlignCenter, format_align_left: AlignLeft, format_align_right: AlignRight,
  add_row: Rows3, add_column: Columns3, insert_col_left: ArrowLeftToLine,
  insert_row_above: ArrowUpToLine, insert_row_below: ArrowDownToLine, insert_col_right: ArrowRightToLine,
  check: Check,
};

export function markdownEditorIcon(name: IconKey) {
  const Icon = icons[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}
