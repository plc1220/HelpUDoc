import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  Trash,
  Edit,
} from 'lucide-react';

import type { File as WorkspaceFile } from '../types';
import { getFileDisplayName, getFileTypeIcon } from '../utils/files';
import {
  buildWorkspaceFileTree,
  collectWorkspaceFolderPaths,
  getWorkspaceAncestorFolderPaths,
  type WorkspaceFileTreeFolderNode,
  type WorkspaceFileTreeLeafNode,
  type WorkspaceFileTreeNode,
} from '../utils/workspaceFileTree';

interface WorkspaceFileTreeProps {
  files: WorkspaceFile[];
  colorMode: 'light' | 'dark';
  selectedFileId: string | null;
  selectedFiles: Set<string>;
  ragStatuses: Record<string, { status?: string; updatedAt?: string; error?: string }>;
  isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
  onSelectFile: (file: WorkspaceFile) => void;
  onToggleFileSelection: (fileId: string) => void;
  onCopyPublicUrl: (file: WorkspaceFile) => void;
  onRenameFile: (file: WorkspaceFile) => void;
  onDeleteFile: (file: WorkspaceFile) => void;
  onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onMoveFile: (file: WorkspaceFile, destinationFolderPath?: string) => void;
}

const getFolderLabel = (node: WorkspaceFileTreeFolderNode) => {
  if (!node.path) {
    return node.name;
  }
  return node.name;
};

const getRagStatus = (
  ragStatuses: Record<string, { status?: string; updatedAt?: string; error?: string }>,
  file: WorkspaceFile,
) => {
  return typeof file.name === 'string' ? ragStatuses[file.name] : undefined;
};

const SlidingFileName: React.FC<{ name: string; colorMode: 'light' | 'dark' }> = ({ name, colorMode }) => {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflowOffset, setOverflowOffset] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) {
      return;
    }

    const updateOverflow = () => {
      const nextOverflow = Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth));
      setOverflowOffset((prev) => (prev === nextOverflow ? prev : nextOverflow));
    };

    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(viewport);
    observer.observe(text);

    return () => observer.disconnect();
  }, [name]);

  return (
    <span ref={viewportRef} className="block min-w-0 overflow-hidden whitespace-nowrap">
      <span
        ref={textRef}
        className={`block w-max max-w-full truncate text-sm leading-snug transition-transform duration-500 ease-out group-hover:truncate-none group-focus-within:truncate-none ${
          colorMode === 'dark' ? 'text-slate-200' : 'text-slate-800'
        }`}
        style={overflowOffset > 0 ? { transform: `translateX(calc(${overflowOffset * -1}px * var(--file-name-slide, 0)))` } : undefined}
      >
        {name}
      </span>
    </span>
  );
};

const TreeFileRow: React.FC<{
  node: WorkspaceFileTreeLeafNode;
  selected: boolean;
  selectedFiles: Set<string>;
  ragStatuses: Record<string, { status?: string; updatedAt?: string; error?: string }>;
  isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
  onSelectFile: (file: WorkspaceFile) => void;
  onToggleFileSelection: (fileId: string) => void;
  onCopyPublicUrl: (file: WorkspaceFile) => void;
  onRenameFile: (file: WorkspaceFile) => void;
  onDeleteFile: (file: WorkspaceFile) => void;
  draggedFileId: string | null;
  setDraggedFileId: (fileId: string | null) => void;
  setDropTargetPath: (path: string | null) => void;
  colorMode: 'light' | 'dark';
}> = ({
  node,
  selected,
  selectedFiles,
  ragStatuses,
  isDraftWorkspaceFile,
  onSelectFile,
  onToggleFileSelection,
  onCopyPublicUrl,
  onRenameFile,
  onDeleteFile,
  draggedFileId,
  setDraggedFileId,
  setDropTargetPath,
  colorMode,
}) => {
  const { file } = node;
  const isPendingJob = file.mimeType === 'application/vnd.helpudoc.paper2slides-job';
  const ragStatus = getRagStatus(ragStatuses, file);
  const ragState = ragStatus?.status ? String(ragStatus.status).toLowerCase() : '';
  const isIndexing = !isPendingJob && ['pending', 'processing', 'preprocessed'].includes(ragState);
  const displayName = getFileDisplayName(file.name || '');
  const fileIcon = getFileTypeIcon(file.name || '');
  const isDraft = isDraftWorkspaceFile(file);
  const isDraggable = !isPendingJob && !isDraft;
  const isBeingDragged = draggedFileId === file.id;
  const isDarkMode = colorMode === 'dark';
  const rowClassName = selected
    ? isDarkMode
      ? 'bg-sky-500/12 ring-1 ring-sky-400/20'
      : 'bg-blue-50/80'
    : isDarkMode
      ? 'hover:bg-slate-800/80'
      : 'hover:bg-slate-100/80';
  const actionsClassName = isDarkMode
    ? 'border-slate-700/80 bg-slate-950/96 shadow-[0_18px_50px_-34px_rgba(2,6,23,0.98)]'
    : 'border-slate-200/80 bg-white/95 shadow-sm';
  const actionButtonClassName = isDarkMode
    ? 'pointer-events-auto rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100'
    : 'pointer-events-auto rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700';

  return (
    <div
      className={`group relative flex items-start gap-2 rounded-lg px-2 py-2 transition-colors ${rowClassName} ${
        isBeingDragged ? 'opacity-40' : ''
      }`}
      draggable={isDraggable}
      onDragStart={(event) => {
        if (!isDraggable) {
          return;
        }
        setDraggedFileId(file.id);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', file.id);
      }}
      onDragEnd={() => {
        setDraggedFileId(null);
        setDropTargetPath(null);
      }}
    >
      <input
        type="checkbox"
        checked={selectedFiles.has(file.id)}
        disabled={isPendingJob}
        onChange={() => onToggleFileSelection(file.id)}
        onClick={(event) => event.stopPropagation()}
        className="mt-1 shrink-0"
      />
      <button
        type="button"
        onClick={() => {
          if (isPendingJob) {
            return;
          }
          onSelectFile(file);
        }}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          {(isPendingJob || isIndexing) && (
            <span className="inline-flex h-4 w-4 items-center justify-center text-blue-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
            </span>
          )}
          <span className="shrink-0" aria-hidden="true">
            {fileIcon}
          </span>
          <SlidingFileName name={displayName} colorMode={colorMode} />
        </div>
      </button>
      {!isPendingJob && (
        <div className={`pointer-events-none absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-lg border pl-2 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${actionsClassName}`}>
          {file.publicUrl && !isDraft && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCopyPublicUrl(file);
              }}
              className={actionButtonClassName}
              title={file.publicUrl}
            >
              <LinkIcon size={14} />
            </button>
          )}
          {!isDraft && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRenameFile(file);
              }}
              className={actionButtonClassName}
              title="Rename"
            >
              <Edit size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteFile(file);
            }}
            className={actionButtonClassName}
            title="Delete"
          >
            <Trash size={14} />
          </button>
        </div>
      )}
    </div>
  );
};

const TreeFolderRow: React.FC<{
  node: WorkspaceFileTreeFolderNode;
  expanded: boolean;
  onToggle: (folderPath: string) => void;
  onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onDropFileToFolder: (fileId: string, folderPath: string) => void;
  draggedFileId: string | null;
  setDropTargetPath: (path: string | null) => void;
  dropTargetPath: string | null;
  children: React.ReactNode;
  colorMode: 'light' | 'dark';
}> = ({
  node,
  expanded,
  onToggle,
  onDeleteFolder,
  onDropFileToFolder,
  draggedFileId,
  setDropTargetPath,
  dropTargetPath,
  children,
  colorMode,
}) => {
  const isDropTarget = dropTargetPath === node.path;
  const canAcceptDrop = Boolean(draggedFileId);
  const isDarkMode = colorMode === 'dark';
  const containerClassName = isDropTarget
    ? isDarkMode
      ? 'bg-sky-500/10 ring-1 ring-sky-400/25'
      : 'bg-blue-50 ring-1 ring-blue-100'
    : isDarkMode
      ? 'hover:bg-slate-800/80'
      : 'hover:bg-slate-100/80';

  return (
    <div className="select-none">
      <div
        className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors ${containerClassName}`}
        onDragOver={(event) => {
          if (!canAcceptDrop) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetPath(node.path);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) {
            return;
          }
          if (dropTargetPath === node.path) {
            setDropTargetPath(null);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const fileId = event.dataTransfer.getData('text/plain') || draggedFileId;
          if (!fileId) {
            return;
          }
          onDropFileToFolder(fileId, node.path);
          setDropTargetPath(null);
        }}
      >
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            isDarkMode
              ? 'text-slate-400 hover:bg-slate-700/70 hover:text-slate-100'
              : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'
          }`}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {expanded ? <FolderOpen size={16} className="shrink-0 text-amber-500" /> : <Folder size={16} className="shrink-0 text-amber-500" />}
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="min-w-0 flex-1 text-left"
          title={node.path || node.name}
        >
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm font-medium ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{getFolderLabel(node)}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              isDarkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'
            }`}>
              {node.fileCount}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDeleteFolder(node);
          }}
          className={`rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
            isDarkMode
              ? 'text-slate-400 hover:bg-slate-700/70 hover:text-slate-100'
              : 'text-slate-500 hover:bg-slate-200 hover:text-slate-700'
          }`}
          title={`Delete folder ${node.path}`}
          aria-label={`Delete folder ${node.path}`}
        >
          <Trash size={14} />
        </button>
      </div>
      {expanded && <div className="mt-1 space-y-1 pl-5">{children}</div>}
    </div>
  );
};

const renderTreeNodes = (
  nodes: WorkspaceFileTreeNode[],
  options: {
    expandedFolders: Set<string>;
    selectedFileId: string | null;
    selectedFiles: Set<string>;
    ragStatuses: Record<string, { status?: string; updatedAt?: string; error?: string }>;
    isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
    onSelectFile: (file: WorkspaceFile) => void;
    onToggleFileSelection: (fileId: string) => void;
    onCopyPublicUrl: (file: WorkspaceFile) => void;
    onRenameFile: (file: WorkspaceFile) => void;
    onDeleteFile: (file: WorkspaceFile) => void;
    onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
    onToggleFolder: (folderPath: string) => void;
    onDropFileToFolder: (fileId: string, folderPath: string) => void;
    draggedFileId: string | null;
    setDraggedFileId: (fileId: string | null) => void;
    setDropTargetPath: (path: string | null) => void;
    dropTargetPath: string | null;
    colorMode: 'light' | 'dark';
  },
): React.ReactNode => {
  return nodes.map((node) => {
    if (node.kind === 'folder') {
      const expanded = options.expandedFolders.has(node.path);
      return (
        <TreeFolderRow
          key={node.id}
          node={node}
          expanded={expanded}
          onToggle={options.onToggleFolder}
          onDeleteFolder={options.onDeleteFolder}
          onDropFileToFolder={options.onDropFileToFolder}
          draggedFileId={options.draggedFileId}
          setDropTargetPath={options.setDropTargetPath}
          dropTargetPath={options.dropTargetPath}
          colorMode={options.colorMode}
        >
          {renderTreeNodes(node.children, options)}
        </TreeFolderRow>
      );
    }

    return (
      <TreeFileRow
        key={node.id}
        node={node}
        selected={options.selectedFileId === node.file.id}
        selectedFiles={options.selectedFiles}
        ragStatuses={options.ragStatuses}
        isDraftWorkspaceFile={options.isDraftWorkspaceFile}
        onSelectFile={options.onSelectFile}
        onToggleFileSelection={options.onToggleFileSelection}
        onCopyPublicUrl={options.onCopyPublicUrl}
        onRenameFile={options.onRenameFile}
        onDeleteFile={options.onDeleteFile}
        draggedFileId={options.draggedFileId}
        setDraggedFileId={options.setDraggedFileId}
        setDropTargetPath={options.setDropTargetPath}
        colorMode={options.colorMode}
      />
    );
  });
};

export default function WorkspaceFileTree({
  files,
  colorMode,
  selectedFileId,
  selectedFiles,
  ragStatuses,
  isDraftWorkspaceFile,
  onSelectFile,
  onToggleFileSelection,
  onCopyPublicUrl,
  onRenameFile,
  onDeleteFile,
  onDeleteFolder,
  onMoveFile,
}: WorkspaceFileTreeProps) {
  const isDarkMode = colorMode === 'dark';
  const tree = useMemo(() => buildWorkspaceFileTree(files), [files]);
  const folderPaths = useMemo(() => collectWorkspaceFolderPaths(tree), [tree]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [hasInitializedExpandedFolders, setHasInitializedExpandedFolders] = useState(false);

  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);

  useEffect(() => {
    if (!hasInitializedExpandedFolders && folderPaths.length > 0) {
      setExpandedFolders(new Set(folderPaths));
      setHasInitializedExpandedFolders(true);
    }
  }, [folderPaths, hasInitializedExpandedFolders]);

  useEffect(() => {
    if (!selectedFileId) {
      return;
    }
    const selectedFile = fileById.get(selectedFileId);
    if (!selectedFile) {
      return;
    }
    const nextPaths = getWorkspaceAncestorFolderPaths(selectedFile.name || '');
    if (!nextPaths.length) {
      return;
    }
    setExpandedFolders((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const path of nextPaths) {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [fileById, selectedFileId]);

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const handleDropFileToFolder = (fileId: string, folderPath: string) => {
    const file = fileById.get(fileId);
    if (!file) {
      return;
    }
    onMoveFile(file, folderPath);
    setDraggedFileId(null);
    setDropTargetPath(null);
  };

  const handleRootDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const fileId = event.dataTransfer.getData('text/plain') || draggedFileId;
    if (!fileId) {
      return;
    }
    handleDropFileToFolder(fileId, '');
  };

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        draggedFileId ? (isDarkMode ? 'bg-sky-500/5' : 'bg-blue-50/30') : ''
      }`}
      onDragOver={(event) => {
        if (!draggedFileId) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={handleRootDrop}
    >
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {tree.children.length ? (
          <div className="space-y-1">
            {renderTreeNodes(tree.children, {
              expandedFolders,
              selectedFileId,
              selectedFiles,
              ragStatuses,
              isDraftWorkspaceFile,
              onSelectFile,
              onToggleFileSelection,
              onCopyPublicUrl,
              onRenameFile,
              onDeleteFile,
              onDeleteFolder,
              onToggleFolder: handleToggleFolder,
              onDropFileToFolder: handleDropFileToFolder,
              draggedFileId,
              setDraggedFileId,
              setDropTargetPath,
              dropTargetPath,
              colorMode,
            })}
          </div>
        ) : (
          <div className={`flex h-full items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center ${
            isDarkMode ? 'border-slate-700/70 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
          }`}>
            <div>
              <Folder className={`mx-auto mb-3 ${isDarkMode ? 'text-slate-600' : 'text-slate-300'}`} size={24} />
              <p className={`text-sm font-medium ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>No files yet</p>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>Upload files to start building a workspace hierarchy.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
