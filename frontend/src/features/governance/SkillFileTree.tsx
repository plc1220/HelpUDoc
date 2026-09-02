import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, FolderClosed, FolderOpen, Trash2 } from 'lucide-react';

/**
 * A folder-aware listing of the files in a governed skill draft.
 *
 * Deliberately separate from `WorkspaceFileTree`, which is bound to workspace file
 * records, Yjs collaboration and drag-and-drop. A skill draft only ever needs the paths.
 */

export type SkillFileEntry = {
  path: string;
  dirty?: boolean;
  binary?: boolean;
};

type FolderNode = {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
};

type FileNode = {
  kind: 'file';
  name: string;
  path: string;
  entry: SkillFileEntry;
};

type TreeNode = FolderNode | FileNode;

const buildSkillFileTree = (entries: SkillFileEntry[]): TreeNode[] => {
  const root: TreeNode[] = [];

  const folderAt = (segments: string[]): TreeNode[] => {
    let level = root;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const currentPrefix = prefix;
      let folder = level.find(
        (node): node is FolderNode => node.kind === 'folder' && node.path === currentPrefix,
      );
      if (!folder) {
        folder = { kind: 'folder', name: segment, path: currentPrefix, children: [] };
        level.push(folder);
      }
      level = folder.children;
    }
    return level;
  };

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (!segments.length) continue;
    const name = segments[segments.length - 1];
    folderAt(segments.slice(0, -1)).push({ kind: 'file', name, path: entry.path, entry });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      // SKILL.md is the entry point of every package, so it leads the root listing.
      if (a.path === 'SKILL.md') return -1;
      if (b.path === 'SKILL.md') return 1;
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === 'folder') sort(node.children);
    }
    return nodes;
  };

  return sort(root);
};

export default function SkillFileTree({
  entries,
  selectedPath,
  onSelect,
  onDelete,
}: {
  entries: SkillFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const tree = useMemo(() => buildSkillFileTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const renderNodes = (nodes: TreeNode[], depth: number) => nodes.map((node) => {
    if (node.kind === 'folder') {
      const isCollapsed = collapsed.has(node.path);
      return (
        <li key={`folder:${node.path}`}>
          <button
            type="button"
            onClick={() => toggle(node.path)}
            aria-expanded={!isCollapsed}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs font-semibold text-slate-600 hover:bg-slate-100"
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            {isCollapsed ? <FolderClosed size={13} /> : <FolderOpen size={13} />}
            <span className="truncate">{node.name}/</span>
          </button>
          {!isCollapsed ? <ul>{renderNodes(node.children, depth + 1)}</ul> : null}
        </li>
      );
    }

    const isSelected = node.path === selectedPath;
    const isRequired = node.path === 'SKILL.md';
    return (
      <li key={`file:${node.path}`} className="group/file flex items-center">
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          aria-current={isSelected ? 'true' : undefined}
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pr-1 text-left text-xs ${
            isSelected ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <FileText size={13} className="shrink-0" />
          <span className="truncate">{node.name}</span>
          {node.entry.dirty ? (
            <span
              aria-label="Unsaved changes"
              className={`ml-auto size-1.5 shrink-0 rounded-full ${isSelected ? 'bg-white' : 'bg-amber-500'}`}
            />
          ) : null}
        </button>
        {!isRequired ? (
          <button
            type="button"
            onClick={() => onDelete(node.path)}
            aria-label={`Remove ${node.path}`}
            className="rounded-md p-1 text-slate-400 opacity-0 transition hover:text-rose-600 focus:opacity-100 group-hover/file:opacity-100"
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </li>
    );
  });

  if (!entries.length) {
    return <p className="px-2 py-3 text-xs text-slate-500">This draft has no files yet.</p>;
  }

  return <ul className="space-y-0.5">{renderNodes(tree, 0)}</ul>;
}
