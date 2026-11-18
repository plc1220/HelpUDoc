export type UploadFile = { file: File; path: string };
export type UploadFailure = { path: string; message: string };
export type UploadBatch = { files: UploadFile[]; folders: string[]; failures: UploadFailure[] };

type Entry = {
  name: string;
  isDirectory: boolean;
  file: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
  createReader: () => {
    readEntries: (
      success: (entries: Entry[]) => void,
      failure: (error: DOMException) => void,
    ) => void;
  };
};

const internalTypes = [
  'application/x-helpudoc-workspace-file-id',
  'application/x-helpudoc-workspace-folder-path',
  'application/x-helpudoc-workspace-image',
];

export const isExternalFileDrop = (transfer: Pick<DataTransfer, 'types'>): boolean => {
  const types = Array.from(transfer.types);
  return types.includes('Files') && !internalTypes.some((type) => types.includes(type));
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not read this item.';

/** Snapshot entries during drop: the browser protects the data store after the handler returns. */
export function collectDroppedFiles(
  transfer: Pick<DataTransfer, 'items' | 'files'>,
): Promise<UploadBatch> {
  const sources = Array.from(transfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => {
      const entryItem = item as unknown as {
        webkitGetAsEntry?: () => Entry | null;
        getAsEntry?: () => Entry | null;
      };
      try {
        return {
          entry: entryItem.getAsEntry?.() || entryItem.webkitGetAsEntry?.(),
          file: item.getAsFile(),
        };
      } catch (error) {
        return { error };
      }
    });
  if (!sources.length)
    sources.push(...Array.from(transfer.files).map((file) => ({ entry: null, file })));

  return (async () => {
    const batch: UploadBatch = { files: [], folders: [], failures: [] };
    const visit = async (entry: Entry, parent: string): Promise<void> => {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      try {
        if (!entry.name || /[/\\]/.test(entry.name) || entry.name === '.' || entry.name === '..') {
          throw new Error('Invalid file or folder name.');
        }
        if (!entry.isDirectory) {
          const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
          batch.files.push({ file, path });
          return;
        }
        batch.folders.push(path);
        const reader = entry.createReader();
        // Chromium returns directory entries in batches (often 100 at a time).
        for (;;) {
          const children = await new Promise<Entry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (!children.length) break;
          for (const child of children) await visit(child, path);
        }
      } catch (error) {
        batch.failures.push({ path, message: errorMessage(error) });
      }
    };
    for (const source of sources) {
      if (source.entry) await visit(source.entry, '');
      else if (source.file) {
        try {
          // Directory placeholders cannot be read as files. Real empty files remain valid.
          await source.file.slice(0, 1).arrayBuffer();
          batch.files.push({ file: source.file, path: source.file.name });
        } catch {
          batch.failures.push({
            path: source.file.name,
            message: 'Cannot read this item. For folders, try + → Upload folder.',
          });
        }
      } else {
        batch.failures.push({
          path: 'Dropped item',
          message:
            'error' in source
              ? errorMessage(source.error)
              : 'Cannot read this item. For folders, try + → Upload folder.',
        });
      }
    }
    return batch;
  })();
}
