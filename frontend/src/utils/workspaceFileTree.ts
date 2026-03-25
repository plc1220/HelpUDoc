import type { File as WorkspaceFile } from '../types';
import { normalizeFilePath } from './files';

export type WorkspaceFileTreeNode = WorkspaceFileTreeFolderNode | WorkspaceFileTreeLeafNode;

export interface WorkspaceFileTreeFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
  depth: number;
  fileCount: number;
  children: WorkspaceFileTreeNode[];
}

export interface WorkspaceFileTreeLeafNode {
  kind: 'file';
  id: string;
  name: string;
  path: string;
  depth: number;
  file: WorkspaceFile;
}

export const splitWorkspacePath = (value: string): string[] => {
  const normalized = normalizeFilePath(value || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '.') {
    return [];
  }
  return normalized.split('/').filter(Boolean);
};

export const normalizeWorkspaceFolderPath = (value: string): string => splitWorkspacePath(value).join('/');

export const getWorkspaceParentFolderPath = (value: string): string => {
  const parts = splitWorkspacePath(value);
  if (parts.length <= 1) {
    return '';
  }
  return parts.slice(0, -1).join('/');
};

export const getWorkspaceAncestorFolderPaths = (value: string): string[] => {
  const parts = splitWorkspacePath(value);
  const paths: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    paths.push(parts.slice(0, index).join('/'));
  }
  return paths;
};

export const buildWorkspaceDestinationPath = (fileName: string, destinationFolderPath: string): string => {
  const fileParts = splitWorkspacePath(fileName);
  if (!fileParts.length) {
    return normalizeWorkspaceFolderPath(destinationFolderPath);
  }
  const baseName = fileParts[fileParts.length - 1];
  const folderParts = splitWorkspacePath(destinationFolderPath);
  return [...folderParts, baseName].join('/');
};

const compareTreeNodes = (left: WorkspaceFileTreeNode, right: WorkspaceFileTreeNode): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'folder' ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
};

const sortChildren = (node: WorkspaceFileTreeFolderNode): void => {
  node.children.sort(compareTreeNodes);
  node.children.forEach((child) => {
    if (child.kind === 'folder') {
      sortChildren(child);
    }
  });
};

const countFiles = (node: WorkspaceFileTreeFolderNode): number => {
  let total = 0;
  for (const child of node.children) {
    if (child.kind === 'file') {
      total += 1;
    } else {
      total += countFiles(child);
    }
  }
  node.fileCount = total;
  return total;
};

export const buildWorkspaceFileTree = (files: WorkspaceFile[]): WorkspaceFileTreeFolderNode => {
  const root: WorkspaceFileTreeFolderNode = {
    kind: 'folder',
    id: 'workspace-root',
    name: 'Workspace root',
    path: '',
    depth: 0,
    fileCount: 0,
    children: [],
  };

  const folderIndex = new Map<string, WorkspaceFileTreeFolderNode>();
  folderIndex.set('', root);

  const sortedFiles = [...files].sort((left, right) =>
    normalizeFilePath(left.name || '').localeCompare(
      normalizeFilePath(right.name || ''),
      undefined,
      { numeric: true, sensitivity: 'base' },
    ),
  );

  for (const file of sortedFiles) {
    const parts = splitWorkspacePath(file.name || '');
    if (!parts.length) {
      continue;
    }

    let currentFolder = root;
    let currentPath = '';

    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folderNode = folderIndex.get(currentPath);
      if (!folderNode) {
        folderNode = {
          kind: 'folder',
          id: `folder:${currentPath}`,
          name: segment,
          path: currentPath,
          depth: index + 1,
          fileCount: 0,
          children: [],
        };
        folderIndex.set(currentPath, folderNode);
        currentFolder.children.push(folderNode);
      }
      currentFolder = folderNode;
    }

    const leafName = parts[parts.length - 1];
    currentFolder.children.push({
      kind: 'file',
      id: file.id,
      name: leafName,
      path: normalizeFilePath(file.name || ''),
      depth: parts.length - 1,
      file,
    });
  }

  sortChildren(root);
  countFiles(root);
  return root;
};

export const collectWorkspaceFolderPaths = (node: WorkspaceFileTreeFolderNode): string[] => {
  const paths: string[] = [];
  for (const child of node.children) {
    if (child.kind === 'folder') {
      paths.push(child.path);
      paths.push(...collectWorkspaceFolderPaths(child));
    }
  }
  return paths;
};
