import type { File as WorkspaceFile } from '../types';
import { normalizeFilePath } from './filePaths.ts';

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

/**
 * Join a folder name typed by the user onto the parent folder it is being created
 * in. Returns `null` for a path that must not be built.
 *
 * Slashes in the typed part are kept, so `q1/drafts` under `reports` creates
 * `reports/q1/drafts` — the backend already does a recursive mkdir, so there is no
 * reason to forbid it. Traversal segments are refused here so the dialog can show a
 * useful message; the server rejects them too (`normalizeRelativeFolderPath`), and
 * this does not replace that check.
 */
export const buildWorkspaceSubfolderPath = (
  parentFolderPath: string,
  typedName: string,
): string | null => {
  // The typed part must contribute segments of its own. `splitWorkspacePath`
  // swallows a lone '.', which would otherwise silently resolve to the parent and
  // "succeed" by re-creating a folder that already exists.
  const typedParts = splitWorkspacePath(typedName);
  if (!typedParts.length) {
    return null;
  }
  const parts = [...splitWorkspacePath(parentFolderPath), ...typedParts]
    // Surrounding spaces in a directory name are a filesystem footgun, and a
    // segment that is *only* whitespace would otherwise become a folder named '  '.
    .map((part) => part.trim());
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return parts.join('/');
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

export const buildWorkspaceFileTree = (files: WorkspaceFile[], explicitFolderPaths: string[] = []): WorkspaceFileTreeFolderNode => {
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

  const ensureFolder = (folderPath: string) => {
    const parts = splitWorkspacePath(folderPath);
    let currentFolder = root;
    let currentPath = '';

    for (let index = 0; index < parts.length; index += 1) {
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

    return currentFolder;
  };

  explicitFolderPaths.forEach(ensureFolder);

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

    const currentFolder = ensureFolder(parts.slice(0, -1).join('/'));

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
