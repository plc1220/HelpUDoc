import { useState } from 'react';
import { Dialog, DialogActions, DialogContent, DialogTitle, Button } from '@mui/material';
import type { FolderChoices, FolderConflict } from '../utils/workspaceUploads';

export default function WorkspaceUploadConflictDialog({
  conflicts,
  onResolve,
}: {
  conflicts: FolderConflict[];
  onResolve: (choices: FolderChoices | null) => void;
}) {
  const [choices, setChoices] = useState<FolderChoices>(() =>
    Object.fromEntries(conflicts.map((item) => [item.name, 'copy'])),
  );
  return (
    <Dialog
      open
      onClose={() => onResolve(null)}
      fullWidth
      maxWidth="sm"
      sx={{ zIndex: 1800 }}
      aria-labelledby="upload-conflict-title"
      aria-describedby="upload-conflict-description"
    >
      <DialogTitle id="upload-conflict-title">Folders already exist</DialogTitle>
      <DialogContent>
        <p id="upload-conflict-description" className="mb-4 text-sm">
          Choose where to upload each folder. Existing files will be kept and duplicate filenames get
          numbered copies.
        </p>
        {conflicts.map((item) => (
          <label key={item.name} className="mb-4 block text-sm">
            <span className="mb-1 block break-words font-medium">{item.path}</span>
            <select
              aria-label={`Upload choice for ${item.name}`}
              value={choices[item.name]}
              onChange={(event) =>
                setChoices((previous) => ({
                  ...previous,
                  [item.name]: event.target.value as 'copy' | 'merge',
                }))
              }
              className="w-full rounded border border-[var(--border-color)] bg-[var(--app-bg)] p-2 text-[var(--text-primary)]"
            >
              <option value="copy">Create separate copy</option>
              {item.canMerge && <option value="merge">Merge into existing folder</option>}
            </select>
            {!item.canMerge && (
              <span className="mt-1 block">
                A file already uses this name, so this folder needs a separate copy.
              </span>
            )}
          </label>
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onResolve(null)}>Cancel</Button>
        <Button variant="contained" onClick={() => onResolve(choices)}>
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}
