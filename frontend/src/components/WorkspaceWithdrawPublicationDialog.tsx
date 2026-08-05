import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';

import type { Workspace } from '../types';
import { withdrawWorkspacePublication } from '../services/workspaceApi';

type WorkspaceWithdrawPublicationDialogProps = {
  open: boolean;
  workspace: Workspace | null;
  onClose: () => void;
  onWithdrawn: () => void | Promise<void>;
};

const WorkspaceWithdrawPublicationDialog: React.FC<WorkspaceWithdrawPublicationDialogProps> = ({
  open,
  workspace,
  onClose,
  onWithdrawn,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) setError('');
  }, [open, workspace?.id]);

  const handleWithdraw = async () => {
    if (!workspace) return;
    setBusy(true);
    setError('');
    try {
      await withdrawWorkspacePublication(workspace.id);
      await onWithdrawn();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to withdraw publication');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Withdraw publication?</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2">
          <strong>{workspace?.name}</strong> will no longer have a current published version.
          Its Shared working version and immutable publication history will be preserved.
        </Typography>
        <Alert severity="info" sx={{ mt: 2 }}>
          You can publish the working version again later. The next publication will use a new version number.
        </Alert>
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={() => void handleWithdraw()} disabled={busy}>
          {busy ? 'Withdrawing…' : 'Withdraw publication'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspaceWithdrawPublicationDialog;
