import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  Trash,
  Edit,
} from 'lucide-react';

import type { DashboardArtifactInfo, File as WorkspaceFile } from '../types';
import { getFileDisplayName, getFileTypeIcon } from '../utils/files';
import {
  buildWorkspaceFileTree,
  getWorkspaceAncestorFolderPaths,
  type WorkspaceFileTreeFolderNode,
  type WorkspaceFileTreeLeafNode,
  type WorkspaceFileTreeNode,
} from '../utils/workspaceFileTree';

const WORKSPACE_FILE_DRAG_MIME = 'application/x-helpudoc-workspace-file-id';

const canAcceptWorkspaceFileDrop = (
  event: React.DragEvent,
  draggedFileIdRef: React.RefObject<string | null>,
): boolean =>
  draggedFileIdRef.current != null
  || event.dataTransfer.types.includes(WORKSPACE_FILE_DRAG_MIME)
  || event.dataTransfer.types.includes('text/plain');

const readDroppedFileId = (
  event: React.DragEvent,
  draggedFileIdRef: React.RefObject<string | null>,
): string | null => {
  const fromDataTransfer = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME);
  const fromText = event.dataTransfer.getData('text/plain');
  return fromDataTransfer || draggedFileIdRef.current || fromText || null;
};

const getWorkspaceFolderPathFromPoint = (clientX: number, clientY: number): string | null => {
  const folderRows = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-folder-path]'));
  for (const row of folderRows) {
    const rect = row.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return row.dataset.workspaceFolderPath ?? null;
    }
  }

  const target = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('[data-workspace-folder-path]');
  return target?.dataset.workspaceFolderPath ?? null;
};

const getWorkspaceDropPathFromPoint = (clientX: number, clientY: number): string | null => {
  const folderPath = getWorkspaceFolderPathFromPoint(clientX, clientY);
  if (folderPath != null) {
    return folderPath;
  }
  const root = document.querySelector<HTMLElement>('[data-workspace-file-tree-root]');
  if (!root) {
    return null;
  }
  const rect = root.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    ? ''
    : null;
};

interface WorkspaceFileTreeProps {
  files: WorkspaceFile[];
  folderPaths?: string[];
  colorMode: 'light' | 'dark';
  selectedFileId: string | null;
  selectedDashboardPath?: string | null;
  selectedFiles: Set<string>;
  copiedPublicUrlFileId: string | null;
  dashboardArtifactsByPath?: Record<string, DashboardArtifactInfo>;
  readOnly?: boolean;
  isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
  onSelectFile: (file: WorkspaceFile) => void;
  onSelectFolder?: (folderPath: string) => void;
  onToggleFileSelection: (fileId: string) => void;
  onCopyPublicUrl: (file: WorkspaceFile) => void;
  onRenameFile: (file: WorkspaceFile) => void;
  onRenameFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onDeleteFile: (file: WorkspaceFile) => void;
  onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onMoveFiles: (files: WorkspaceFile[], destinationFolderPath: string) => void;
}

const getFolderLabel = (node: WorkspaceFileTreeFolderNode) => {
  if (!node.path) {
    return node.name;
  }
  if (node.path === '.system') {
    return 'System';
  }
  return node.name;
};

const isDashboardFolderPath = (folderPath: string) => {
  const normalized = (folderPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length === 2 && parts[0] === 'dashboards';
};

const getDashboardArtifactForFolderPath = (
  dashboardArtifactsByPath: Record<string, DashboardArtifactInfo> | undefined,
  folderPath: string,
) => {
  if (!dashboardArtifactsByPath) {
    return undefined;
  }
  const normalized = (folderPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const exact = dashboardArtifactsByPath[normalized];
  if (exact) {
    return exact;
  }
  const descendantArtifacts = Object.entries(dashboardArtifactsByPath)
    .filter(([path]) => path.startsWith(`${normalized}/`))
    .map(([, artifact]) => artifact);
  return descendantArtifacts.length === 1 ? descendantArtifacts[0] : undefined;
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
        className={`block w-max max-w-full truncate text-[13px] leading-snug transition-transform duration-500 ease-out group-hover:truncate-none group-focus-within:truncate-none ${
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
  dashboardArtifactsByPath?: Record<string, DashboardArtifactInfo>;
  isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
  onSelectFile: (file: WorkspaceFile) => void;
  onToggleFileSelection: (fileId: string) => void;
  onCopyPublicUrl: (file: WorkspaceFile) => void;
  copiedPublicUrlFileId: string | null;
  onRenameFile: (file: WorkspaceFile) => void;
  onDeleteFile: (file: WorkspaceFile) => void;
  onDropFilesToFolder: (fileId: string, folderPath: string) => void;
  draggedFileId: string | null;
  draggedFileIdRef: React.RefObject<string | null>;
  setDraggedFileId: (fileId: string | null) => void;
  setDropTargetPath: (path: string | null) => void;
  colorMode: 'light' | 'dark';
  readOnly: boolean;
}> = ({
  node,
  selected,
  selectedFiles,
  dashboardArtifactsByPath,
  isDraftWorkspaceFile,
  onSelectFile,
  onToggleFileSelection,
  onCopyPublicUrl,
  copiedPublicUrlFileId,
  onRenameFile,
  onDeleteFile,
  onDropFilesToFolder,
  draggedFileId,
  draggedFileIdRef,
  setDraggedFileId,
  setDropTargetPath,
  colorMode,
  readOnly,
}) => {
  const { file } = node;
  const displayName = getFileDisplayName(file.name || '');
  const fileIcon = getFileTypeIcon(file.name || '');
  const isDraft = isDraftWorkspaceFile(file);
  const isDraggable = !isDraft && !readOnly;
  const fileId = String(file.id);
  const isBeingDragged = draggedFileId === fileId;
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
  const dashboardPath = (file.path || file.name || '').replace(/\\/g, '/');
  const dashboardArtifact = dashboardPath ? dashboardArtifactsByPath?.[dashboardPath] : undefined;
  const dashboardBadge = dashboardArtifact?.status;
  const handleDragStart = (event: React.DragEvent) => {
    if (!isDraggable) {
      return;
    }
    draggedFileIdRef.current = fileId;
    setDraggedFileId(fileId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(WORKSPACE_FILE_DRAG_MIME, fileId);
    event.dataTransfer.setData('text/plain', fileId);
  };
  const clearDragState = () => {
    draggedFileIdRef.current = null;
    setDraggedFileId(null);
    setDropTargetPath(null);
  };
  return (
    <div
      className={`group relative flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors ${rowClassName} ${
        isBeingDragged ? 'opacity-40' : ''
      }`}
      title={node.path}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={(event) => {
        const fileIdToDrop = draggedFileIdRef.current;
        const dropPath = getWorkspaceDropPathFromPoint(event.clientX, event.clientY);
        if (fileIdToDrop && dropPath != null) {
          onDropFilesToFolder(fileIdToDrop, dropPath);
          return;
        }
        clearDragState();
      }}
    >
      {!readOnly ? (
        <input
          type="checkbox"
          checked={selectedFiles.has(fileId)}
          onChange={() => onToggleFileSelection(fileId)}
          onClick={(event) => event.stopPropagation()}
          className="mt-1 shrink-0"
        />
      ) : null}
      <div
        role="button"
        tabIndex={0}
        data-workspace-file-drag-handle="true"
        onClick={() => {
          onSelectFile(file);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }
          event.preventDefault();
          onSelectFile(file);
        }}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0" aria-hidden="true">
              {fileIcon}
            </span>
            <SlidingFileName name={displayName} colorMode={colorMode} />
            {dashboardBadge && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  dashboardBadge === 'ready'
                    ? 'bg-emerald-100 text-emerald-800'
                    : dashboardBadge === 'generating'
                      ? 'bg-amber-100 text-amber-800'
                      : dashboardBadge === 'error'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-blue-100 text-blue-800'
                }`}
              >
                {dashboardBadge}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className={`pointer-events-none absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-lg border pl-2 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${actionsClassName}`}>
          {file.publicUrl && !isDraft && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCopyPublicUrl(file);
              }}
              className={actionButtonClassName}
              title={copiedPublicUrlFileId === file.id ? 'Copied!' : 'Copy public URL'}
              aria-label={copiedPublicUrlFileId === file.id ? 'Copied to clipboard' : 'Copy public URL'}
            >
              {copiedPublicUrlFileId === file.id ? (
                <Check size={14} className={isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} />
              ) : (
                <LinkIcon size={14} />
              )}
            </button>
          )}
          {!isDraft && !readOnly && (
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
          {!readOnly ? <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteFile(file);
            }}
            className={actionButtonClassName}
            title="Delete"
          >
            <Trash size={14} />
          </button> : null}
      </div>
    </div>
  );
};

const TreeFolderRow: React.FC<{
  node: WorkspaceFileTreeFolderNode;
  expanded: boolean;
  dashboardArtifact?: DashboardArtifactInfo;
  onSelectFolder?: (folderPath: string) => void;
  onToggle: (folderPath: string) => void;
  onRenameFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
  onDropFilesToFolder: (fileId: string, folderPath: string) => void;
  draggedFileIdRef: React.RefObject<string | null>;
  setDropTargetPath: (path: string | null) => void;
  dropTargetPath: string | null;
  children: React.ReactNode;
  colorMode: 'light' | 'dark';
  readOnly: boolean;
}> = ({
  node,
  expanded,
  dashboardArtifact,
  onSelectFolder,
  onToggle,
  onRenameFolder,
  onDeleteFolder,
  onDropFilesToFolder,
  draggedFileIdRef,
  setDropTargetPath,
  dropTargetPath,
  children,
  colorMode,
  readOnly,
}) => {
  const isDropTarget = dropTargetPath === node.path;
  const isDarkMode = colorMode === 'dark';
  const containerClassName = isDropTarget
    ? isDarkMode
      ? 'bg-sky-500/10 ring-1 ring-sky-400/25'
      : 'bg-blue-50 ring-1 ring-blue-100'
    : isDarkMode
      ? 'hover:bg-slate-800/80'
      : 'hover:bg-slate-100/80';
  const isDashboardFolder = isDashboardFolderPath(node.path);
  const dashboardBadge = dashboardArtifact?.status;

  const handleFolderDragOver = (event: React.DragEvent) => {
    if (!canAcceptWorkspaceFileDrop(event, draggedFileIdRef)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetPath(node.path);
  };

  const handleFolderDragLeave = (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    if (dropTargetPath === node.path) {
      setDropTargetPath(null);
    }
  };

  const handleFolderDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const fileId = readDroppedFileId(event, draggedFileIdRef);
    if (!fileId) {
      return;
    }
    onDropFilesToFolder(fileId, node.path);
    setDropTargetPath(null);
  };

  return (
    <div
      className="select-none"
      data-workspace-folder-path={node.path}
      onDragOver={readOnly ? undefined : handleFolderDragOver}
      onDragLeave={readOnly ? undefined : handleFolderDragLeave}
      onDrop={readOnly ? undefined : handleFolderDrop}
    >
      <div
        className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${containerClassName}`}
      >
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
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
          onClick={() => {
            if (isDashboardFolder && onSelectFolder) {
              onSelectFolder(node.path);
              return;
            }
            onToggle(node.path);
          }}
          className="min-w-0 flex-1 text-left"
          title={node.path || node.name}
        >
          <div className="flex items-center gap-2">
            <span className={`truncate text-[13px] font-medium ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{getFolderLabel(node)}</span>
            {dashboardBadge && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  dashboardBadge === 'ready'
                    ? 'bg-emerald-100 text-emerald-800'
                    : dashboardBadge === 'generating'
                      ? 'bg-amber-100 text-amber-800'
                      : dashboardBadge === 'error'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-blue-100 text-blue-800'
                }`}
              >
                {dashboardBadge}
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              isDarkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'
            }`}>
              {node.fileCount}
            </span>
          </div>
        </button>
        {!readOnly ? <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRenameFolder(node);
          }}
          className={`rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
            isDarkMode
              ? 'text-slate-400 hover:bg-slate-700/70 hover:text-slate-100'
              : 'text-slate-500 hover:bg-slate-200 hover:text-slate-700'
          }`}
          title={`Rename folder ${node.path}`}
          aria-label={`Rename folder ${node.path}`}
        >
          <Edit size={14} />
        </button> : null}
        {!readOnly ? <button
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
        </button> : null}
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
    selectedDashboardPath?: string | null;
    selectedFiles: Set<string>;
    dashboardArtifactsByPath?: Record<string, DashboardArtifactInfo>;
    isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
    onSelectFile: (file: WorkspaceFile) => void;
    onSelectFolder?: (folderPath: string) => void;
    onToggleFileSelection: (fileId: string) => void;
    onCopyPublicUrl: (file: WorkspaceFile) => void;
    copiedPublicUrlFileId: string | null;
    onRenameFile: (file: WorkspaceFile) => void;
    onRenameFolder: (folder: WorkspaceFileTreeFolderNode) => void;
    onDeleteFile: (file: WorkspaceFile) => void;
    onDeleteFolder: (folder: WorkspaceFileTreeFolderNode) => void;
    onToggleFolder: (folderPath: string) => void;
    onDropFilesToFolder: (fileId: string, folderPath: string) => void;
    draggedFileId: string | null;
    draggedFileIdRef: React.RefObject<string | null>;
    setDraggedFileId: (fileId: string | null) => void;
    setDropTargetPath: (path: string | null) => void;
    dropTargetPath: string | null;
    colorMode: 'light' | 'dark';
    readOnly: boolean;
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
          dashboardArtifact={getDashboardArtifactForFolderPath(options.dashboardArtifactsByPath, node.path)}
          onSelectFolder={options.onSelectFolder}
          onToggle={options.onToggleFolder}
          onRenameFolder={options.onRenameFolder}
          onDeleteFolder={options.onDeleteFolder}
          onDropFilesToFolder={options.onDropFilesToFolder}
          draggedFileIdRef={options.draggedFileIdRef}
          setDropTargetPath={options.setDropTargetPath}
          dropTargetPath={options.dropTargetPath}
          colorMode={options.colorMode}
          readOnly={options.readOnly}
        >
          {renderTreeNodes(node.children, options)}
        </TreeFolderRow>
      );
    }

    return (
      <TreeFileRow
        key={node.id}
        node={node}
        selected={String(options.selectedFileId) === String(node.file.id)}
        selectedFiles={options.selectedFiles}
        dashboardArtifactsByPath={options.dashboardArtifactsByPath}
        isDraftWorkspaceFile={options.isDraftWorkspaceFile}
        onSelectFile={options.onSelectFile}
        onToggleFileSelection={options.onToggleFileSelection}
        onCopyPublicUrl={options.onCopyPublicUrl}
        copiedPublicUrlFileId={options.copiedPublicUrlFileId}
        onRenameFile={options.onRenameFile}
        onDeleteFile={options.onDeleteFile}
        onDropFilesToFolder={options.onDropFilesToFolder}
        draggedFileId={options.draggedFileId}
        draggedFileIdRef={options.draggedFileIdRef}
        setDraggedFileId={options.setDraggedFileId}
        setDropTargetPath={options.setDropTargetPath}
        colorMode={options.colorMode}
        readOnly={options.readOnly}
      />
    );
  });
};

export default function WorkspaceFileTree({
  files,
  folderPaths: explicitFolderPaths = [],
  colorMode,
  selectedFileId,
  selectedDashboardPath,
  selectedFiles,
  dashboardArtifactsByPath,
  readOnly = false,
  isDraftWorkspaceFile,
  onSelectFile,
  onSelectFolder,
  onToggleFileSelection,
  onCopyPublicUrl,
  copiedPublicUrlFileId,
  onRenameFile,
  onRenameFolder,
  onDeleteFile,
  onDeleteFolder,
  onMoveFiles,
}: WorkspaceFileTreeProps) {
  const isDarkMode = colorMode === 'dark';
  const tree = useMemo(() => buildWorkspaceFileTree(files, explicitFolderPaths), [files, explicitFolderPaths]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const draggedFileIdRef = useRef<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const fileById = useMemo(() => new Map(files.map((file) => [String(file.id), file])), [files]);

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

  useEffect(() => {
    if (!selectedDashboardPath) {
      return;
    }
    const nextPaths = getWorkspaceAncestorFolderPaths(selectedDashboardPath);
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
  }, [selectedDashboardPath]);

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

  const handleDropFilesToFolder = (fileId: string, folderPath: string) => {
    const file = fileById.get(fileId);
    if (!file) {
      return;
    }
    const draggedFileIsSelected = selectedFiles.has(fileId);
    const filesToMove = draggedFileIsSelected
      ? Array.from(selectedFiles)
          .map((selectedFileId) => fileById.get(selectedFileId))
          .filter((selectedFile): selectedFile is WorkspaceFile => Boolean(selectedFile))
          .filter((selectedFile) => !isDraftWorkspaceFile(selectedFile))
      : [file];
    if (!readOnly && filesToMove.length > 0) {
      onMoveFiles(filesToMove, folderPath);
    }
    draggedFileIdRef.current = null;
    setDraggedFileId(null);
    setDropTargetPath(null);
  };

  const handleRootDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const folderTarget = (event.target as HTMLElement | null)?.closest('[data-workspace-folder-path]');
    if (folderTarget) {
      return;
    }
    const fileId = readDroppedFileId(event, draggedFileIdRef);
    if (!fileId) {
      return;
    }
    const dropPath = getWorkspaceDropPathFromPoint(event.clientX, event.clientY) ?? dropTargetPath;
    if (dropPath != null) {
      handleDropFilesToFolder(fileId, dropPath);
    }
  };

  return (
    <div
      data-workspace-file-tree-root="true"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        draggedFileId ? (isDarkMode ? 'bg-sky-500/5' : 'bg-blue-50/30') : ''
      }`}
      onDragOver={readOnly ? undefined : (event) => {
        if (!canAcceptWorkspaceFileDrop(event, draggedFileIdRef)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTargetPath(getWorkspaceFolderPathFromPoint(event.clientX, event.clientY));
      }}
      onDrop={readOnly ? undefined : handleRootDrop}
    >
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {tree.children.length ? (
          <div className="space-y-1">
            {renderTreeNodes(tree.children, {
              expandedFolders,
              selectedFileId,
              selectedDashboardPath,
              selectedFiles,
              dashboardArtifactsByPath,
              isDraftWorkspaceFile,
              onSelectFile,
              onSelectFolder,
              onToggleFileSelection,
              onCopyPublicUrl,
              copiedPublicUrlFileId,
              onRenameFile,
              onRenameFolder,
              onDeleteFile,
              onDeleteFolder,
              onToggleFolder: handleToggleFolder,
              onDropFilesToFolder: handleDropFilesToFolder,
              draggedFileId,
              draggedFileIdRef,
              setDraggedFileId,
              setDropTargetPath,
              dropTargetPath,
              colorMode,
              readOnly,
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
