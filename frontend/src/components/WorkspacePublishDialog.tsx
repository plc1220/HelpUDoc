import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';

import type { Workspace } from '../types';
import { publishWorkspace } from '../services/workspaceApi';

/**
 * Locks the current Working version of a Shared workspace into an immutable
 * version.
 *
 * This used to be two dialogs in one: the same component asked a private
 * workspace who to share it with, and a Shared workspace whether to lock. They
 * are unrelated jobs, and keeping them together is how sharing ended up with a
 * surface that could only ever grant access once, with no way to see or remove
 * it afterwards. Sharing now lives in `WorkspaceShareDialog`, which serves both
 * states.
 */
type WorkspacePublishDialogProps = {
  open: boolean;
  workspace: Workspace | null;
  onClose: () => void;
  onBeforePublish?: (workspace: Workspace) => void | Promise<void>;
  onPublished: () => void | Promise<void>;
};

const WorkspacePublishDialog: React.FC<WorkspacePublishDialogProps> = ({
  open,
  workspace,
  onClose,
  onBeforePublish,
  onPublished,
}) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setNote('');
      setError('');
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    setError('');
    try {
      await onBeforePublish?.(workspace);
      await publishWorkspace(workspace.id, { note: note.trim() || undefined });
      await onPublished();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Lock current changes</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Create an immutable locked version from the current Working version of{' '}
          <strong>{workspace?.name}</strong>. Live work continues afterward, and the locked
          snapshot cannot be edited.
        </Typography>
        <TextField
          label="Lock note (optional)"
          placeholder="Describe this locked version"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          multiline
          minRows={3}
          fullWidth
          inputProps={{ maxLength: 1000 }}
        />
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void handleSubmit()} disabled={!workspace || busy}>
          {busy ? <CircularProgress size={22} color="inherit" /> : 'Lock current changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspacePublishDialog;
