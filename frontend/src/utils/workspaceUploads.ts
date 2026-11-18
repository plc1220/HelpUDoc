import type { UploadBatch, UploadFailure } from './workspaceFileDrop.ts';

export type FolderConflict = { name: string; path: string; canMerge: boolean };
export type FolderChoices = Record<string, 'merge' | 'copy'>;
export type UploadProgress = { completed: number; total: number; path: string };
export type UploadResult = {
  uploadedFiles: number;
  createdFolders: number;
  failures: UploadFailure[];
};

const join = (parent: string, child: string) => (parent ? `${parent}/${child}` : child);

function catalog(fileNames: string[], folderNames: string[]) {
  const files = new Set(fileNames);
  const folders = new Set(folderNames);
  for (const name of [...fileNames, ...folderNames]) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      folders.add(parts.join('/'));
    }
  }
  return { files, folders };
}

export function findFolderConflicts(
  batch: UploadBatch,
  destination: string,
  fileNames: string[],
  folderNames: string[],
): FolderConflict[] {
  const { files, folders } = catalog(fileNames, folderNames);
  return batch.folders
    .filter((path) => !path.includes('/'))
    .flatMap((name) => {
      const path = join(destination, name);
      return files.has(path) || folders.has(path)
        ? [{ name, path, canMerge: !files.has(path) }]
        : [];
    });
}

/** Plan every destination before writing, reserving incoming names as well as existing names. */
export function planDroppedUpload(
  batch: UploadBatch,
  destination: string,
  fileNames: string[],
  folderNames: string[],
  choices: FolderChoices,
): UploadBatch {
  const { files, folders } = catalog(fileNames, folderNames);
  const occupied = new Set([
    ...files,
    ...folders,
    ...batch.folders.map((name) => join(destination, name)),
    ...batch.files.map((item) => join(destination, item.path)),
  ]);
  const roots = new Map<string, string>();
  for (const conflict of findFolderConflicts(batch, destination, fileNames, folderNames)) {
    const choice = Object.hasOwn(choices, conflict.name) ? choices[conflict.name] : undefined;
    if ((choice !== 'merge' && choice !== 'copy') || (choice === 'merge' && !conflict.canMerge)) {
      throw new Error(
        `Folder conflict changed for ${conflict.name}. Drop it again to review the destination.`,
      );
    }
    if (choice === 'copy') {
      let number = 2;
      let name = `${conflict.name} (${number})`;
      while (occupied.has(join(destination, name))) name = `${conflict.name} (${++number})`;
      occupied.add(join(destination, name));
      roots.set(conflict.name, name);
    }
  }
  const resolve = (path: string) => {
    const [root, ...rest] = path.split('/');
    return join(destination, [roots.get(root) || root, ...rest].join('/'));
  };
  const resolvedFolders = batch.folders.map(resolve);
  for (const path of resolvedFolders) {
    if (files.has(path)) {
      throw new Error(
        `A file already uses folder path ${path}. Choose a separate copy instead of merging.`,
      );
    }
  }
  const directories = new Set([...folders, ...resolvedFolders]);
  const reserved = new Set([
    ...occupied,
    ...resolvedFolders,
    ...batch.files.map((item) => resolve(item.path)),
  ]);
  const assignedFiles = new Set<string>();
  const resolvedFiles = batch.files.map((item) => {
    let path = resolve(item.path);
    // Reserve files and folders together: the API's duplicate-file numbering
    // does not consider folder names when choosing the next available filename.
    if (files.has(path) || directories.has(path) || assignedFiles.has(path)) {
      const slash = path.lastIndexOf('/');
      const parent = path.slice(0, slash + 1);
      const name = path.slice(slash + 1);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : '';
      let number = 2;
      do {
        path = `${parent}${stem} (${number++})${extension}`;
      } while (reserved.has(path));
      reserved.add(path);
    }
    assignedFiles.add(path);
    return { ...item, path };
  });
  return {
    files: resolvedFiles,
    folders: resolvedFolders.filter((path) => !folders.has(path)),
    failures: batch.failures,
  };
}

export async function uploadWorkspaceBatch(
  workspaceId: string,
  batch: UploadBatch,
  api: {
    createFile: (workspaceId: string, file: File, path: string) => Promise<unknown>;
    createFolder: (workspaceId: string, path: string) => Promise<unknown>;
  },
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const result: UploadResult = {
    uploadedFiles: 0,
    createdFolders: 0,
    failures: [...batch.failures],
  };
  const folders = [...new Set(batch.folders)].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );
  const blocked: string[] = [];
  const total = folders.length + batch.files.length;
  let completed = 0;
  const run = async (
    path: string,
    operation: () => Promise<unknown>,
    kind: 'uploadedFiles' | 'createdFolders',
  ) => {
    onProgress?.({ completed, total, path });
    try {
      if (blocked.some((folder) => path.startsWith(`${folder}/`)))
        throw new Error('Parent folder could not be created.');
      await operation();
      result[kind] += 1;
    } catch (error) {
      result.failures.push({
        path,
        message: error instanceof Error ? error.message : 'Upload failed.',
      });
      if (kind === 'createdFolders') blocked.push(path);
    }
    onProgress?.({ completed: ++completed, total, path });
  };
  for (const path of folders)
    await run(path, () => api.createFolder(workspaceId, path), 'createdFolders');
  for (const { file, path } of batch.files)
    await run(path, () => api.createFile(workspaceId, file, path), 'uploadedFiles');
  return result;
}
