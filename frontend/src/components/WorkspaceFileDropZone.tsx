import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { createFile, createFolder, getFiles, getFolders } from '../services/fileApi';
import { collectDroppedFiles, isExternalFileDrop } from '../utils/workspaceFileDrop';
import {
  findFolderConflicts,
  planDroppedUpload,
  uploadWorkspaceBatch,
  type FolderChoices,
  type FolderConflict,
} from '../utils/workspaceUploads';
import WorkspaceUploadConflictDialog from './WorkspaceUploadConflictDialog';

/** Mounted per workspace so a pending confirmation can never target another workspace. */
export default function WorkspaceFileDropZone({
  workspaceId,
  readOnly,
  onUploaded,
  children,
}: {
  workspaceId: string;
  readOnly: boolean;
  onUploaded: (workspaceId: string) => Promise<void>;
  children: (dropTargetPath: string | null) => ReactNode;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<FolderConflict[] | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const readOnlyRef = useRef(readOnly);
  const resolveConflict = useRef<((choices: FolderChoices | null) => void) | null>(null);
  readOnlyRef.current = readOnly;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolveConflict.current?.(null);
    };
  }, []);

  const finishConflict = (choices: FolderChoices | null) => {
    resolveConflict.current?.(choices);
    resolveConflict.current = null;
    setConflicts(null);
  };

  const folderAt = (event: DragEvent) =>
    (event.target as Element).closest<HTMLElement>('[data-workspace-folder-path]')?.dataset
      .workspaceFolderPath || '';

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setTarget(null);
    if (readOnlyRef.current) {
      setFailures(['This workspace is read-only. You need edit access to upload.']);
      return;
    }
    if (busyRef.current) {
      setFailures([
        'An upload is already in progress. Wait for it to finish before dropping more items.',
      ]);
      return;
    }
    const destination = folderAt(event);
    const pendingBatch = collectDroppedFiles(event.dataTransfer);
    busyRef.current = true;
    setBusy(true);
    setFailures([]);
    setMessage('Reading files and folders…');
    void (async () => {
      try {
        const batch = await pendingBatch;
        if (!mounted.current) return;
        if (!batch.files.length && !batch.folders.length) {
          setMessage('Nothing was uploaded.');
          setFailures(batch.failures.map((item) => `${item.path}: ${item.message}`));
          return;
        }
        setMessage('Checking upload destination…');
        const loadCatalog = async () => {
          const [files, folders] = await Promise.all([
            getFiles(workspaceId),
            getFolders(workspaceId),
          ]);
          return { names: (files as { name: string }[]).map((file) => file.name), folders };
        };
        let catalog = await loadCatalog();
        if (!mounted.current) return;
        const clashes = findFolderConflicts(batch, destination, catalog.names, catalog.folders);
        let choices: FolderChoices = {};
        if (clashes.length) {
          const answer = await new Promise<FolderChoices | null>((resolve) => {
            resolveConflict.current = resolve;
            setConflicts(clashes);
          });
          if (!mounted.current) return;
          if (!answer) {
            setMessage('Upload cancelled.');
            return;
          }
          choices = answer;
          catalog = await loadCatalog();
        }
        if (!mounted.current) return;
        if (readOnlyRef.current)
          throw new Error('This workspace is read-only. You need edit access to upload.');
        const planned = planDroppedUpload(
          batch,
          destination,
          catalog.names,
          catalog.folders,
          choices,
        );
        const result = await uploadWorkspaceBatch(
          workspaceId,
          planned,
          { createFile, createFolder },
          (progress) => {
            if (mounted.current)
              setMessage(
                `Uploading ${progress.completed} of ${progress.total} items… ${progress.path}`,
              );
          },
        );
        // Refresh only the owning workspace; the caller guards the current selection.
        if (result.uploadedFiles || result.createdFolders) await onUploaded(workspaceId);
        if (mounted.current) {
          setMessage(
            `Uploaded ${result.uploadedFiles} file${result.uploadedFiles === 1 ? '' : 's'}, created ${result.createdFolders} folder${result.createdFolders === 1 ? '' : 's'}.`,
          );
          setFailures(result.failures.map((item) => `${item.path}: ${item.message}`));
        }
      } catch (error) {
        if (mounted.current) {
          setMessage('Upload could not finish.');
          setFailures([error instanceof Error ? error.message : 'Upload failed.']);
        }
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-workspace-upload-zone="true"
      onDragOverCapture={(event) => {
        if (!isExternalFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = readOnly || busyRef.current ? 'none' : 'copy';
        setTarget(folderAt(event));
      }}
      onDragLeaveCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
      }}
      onDropCapture={handleDrop}
    >
      {(message || failures.length > 0) && (
        <div className="mb-2 shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--app-bg)] p-2 text-xs text-[var(--text-primary)]">
          <div role="status" aria-live="polite" className="break-words">
            {message}
          </div>
          {failures.length > 0 && (
            <div role="alert" className="mt-1 max-h-32 overflow-auto text-red-500">
              <ul>
                {failures.map((failure, index) => (
                  <li key={index}>{failure}</li>
                ))}
              </ul>
            </div>
          )}
          {!busy && (
            <button
              type="button"
              className="mt-1 underline"
              onClick={() => {
                setMessage('');
                setFailures([]);
              }}
            >
              Dismiss upload status
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{children(target)}</div>
      {target !== null && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-end justify-center rounded-xl border-2 p-4"
          data-workspace-upload-overlay="true"
          aria-hidden="true"
          style={{
            borderColor: 'var(--accent)',
            backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)',
          }}
        >
          <div
            className="flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
            data-workspace-upload-label="true"
            style={{
              backgroundColor: 'var(--surface-strong)',
              color: 'var(--text-primary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <Upload size={18} className="shrink-0" />
            <span className="break-words">
              {readOnly
                ? 'Read-only workspace'
                : busy
                  ? 'Upload in progress'
                  : `Drop to upload into ${target || 'workspace root'}`}
            </span>
          </div>
        </div>
      )}
      {conflicts && (
        <WorkspaceUploadConflictDialog conflicts={conflicts} onResolve={finishConflict} />
      )}
    </div>
  );
}
