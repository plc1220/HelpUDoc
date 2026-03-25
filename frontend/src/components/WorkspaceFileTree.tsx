import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  MoveRight,
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
  selectedFileId: string | null;
  selectedFiles: Set<string>;
  ragStatuses: Record<string, { status?: string; updatedAt?: string; error?: string }>;
  isDraftWorkspaceFile: (file?: WorkspaceFile | null) => boolean;
  onSelectFile: (file: WorkspaceFile) => void;
  onToggleFileSelection: (fileId: string) => void;
  onCopyPublicUrl: (file: WorkspaceFile) => void;
  onRenameFile: (file: WorkspaceFile) => void;
  onDeleteFile: (file: WorkspaceFile) => void;
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
  onMoveFile: (file: WorkspaceFile, destinationFolderPath?: string) => void;
  draggedFileId: string | null;
  setDraggedFileId: (fileId: string | null) => void;
  setDropTargetPath: (path: string | null) => void;
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
  onMoveFile,
  draggedFileId,
  setDraggedFileId,
  setDropTargetPath,
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

  return (
    <div
      className={`group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors ${
        selected ? 'bg-blue-50 ring-1 ring-blue-100' : 'hover:bg-slate-100/80'
      } ${isBeingDragged ? 'opacity-40' : ''}`}
      title={file.name}
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
          <span className="min-w-0 break-words text-sm leading-snug text-slate-800">{displayName}</span>
        </div>
      </button>
      {!isPendingJob && (
        <div className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {file.publicUrl && !isDraft && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCopyPublicUrl(file);
              }}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
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
                onMoveFile(file);
              }}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
              title="Move"
            >
              <MoveRight size={14} />
            </button>
          )}
          {!isDraft && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRenameFile(file);
              }}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
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
            className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
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
  onDropFileToFolder: (fileId: string, folderPath: string) => void;
  draggedFileId: string | null;
  setDropTargetPath: (path: string | null) => void;
  dropTargetPath: string | null;
  children: React.ReactNode;
}> = ({
  node,
  expanded,
  onToggle,
  onDropFileToFolder,
  draggedFileId,
  setDropTargetPath,
  dropTargetPath,
  children,
}) => {
  const isDropTarget = dropTargetPath === node.path;
  const canAcceptDrop = Boolean(draggedFileId);

  return (
    <div className="select-none">
      <div
        className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
          isDropTarget ? 'bg-blue-50 ring-1 ring-blue-100' : 'hover:bg-slate-100/80'
        }`}
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
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-800"
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
            <span className="truncate text-sm font-medium text-slate-800">{getFolderLabel(node)}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              {node.fileCount}
            </span>
          </div>
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
    onMoveFile: (file: WorkspaceFile, destinationFolderPath?: string) => void;
    onToggleFolder: (folderPath: string) => void;
    onDropFileToFolder: (fileId: string, folderPath: string) => void;
    draggedFileId: string | null;
    setDraggedFileId: (fileId: string | null) => void;
    setDropTargetPath: (path: string | null) => void;
    dropTargetPath: string | null;
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
          onDropFileToFolder={options.onDropFileToFolder}
          draggedFileId={options.draggedFileId}
          setDropTargetPath={options.setDropTargetPath}
          dropTargetPath={options.dropTargetPath}
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
        onMoveFile={options.onMoveFile}
        draggedFileId={options.draggedFileId}
        setDraggedFileId={options.setDraggedFileId}
        setDropTargetPath={options.setDropTargetPath}
      />
    );
  });
};

export default function WorkspaceFileTree({
  files,
  selectedFileId,
  selectedFiles,
  ragStatuses,
  isDraftWorkspaceFile,
  onSelectFile,
  onToggleFileSelection,
  onCopyPublicUrl,
  onRenameFile,
  onDeleteFile,
  onMoveFile,
}: WorkspaceFileTreeProps) {
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
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-sm"
      onDragOver={(event) => {
        if (!draggedFileId) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={handleRootDrop}
    >
      <div
        className={`border-b border-dashed px-4 py-2 text-xs transition-colors ${
          draggedFileId ? 'border-blue-200 bg-blue-50/60 text-blue-700' : 'border-transparent text-slate-400'
        }`}
      >
        {draggedFileId ? 'Drop here to move a file to the workspace root.' : 'Drag a file onto a folder to move it. Drop here to move to the workspace root.'}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
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
              onMoveFile,
              onToggleFolder: handleToggleFolder,
              onDropFileToFolder: handleDropFileToFolder,
              draggedFileId,
              setDraggedFileId,
              setDropTargetPath,
              dropTargetPath,
            })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
            <div>
              <Folder className="mx-auto mb-3 text-slate-300" size={24} />
              <p className="text-sm font-medium text-slate-700">No files yet</p>
              <p className="mt-1 text-xs text-slate-500">Upload files to start building a workspace hierarchy.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
