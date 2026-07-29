import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';

import type { Workspace } from '../types';
import {
  listPublishedWorkspaceHistory,
  restorePublishedWorkspaceVersion,
  type PublishedWorkspaceVersion,
} from '../services/workspaceApi';

type WorkspaceHistoryDialogProps = {
  open: boolean;
  workspace: Workspace | null;
  onClose: () => void;
  onRestored: () => void | Promise<void>;
};

const WorkspaceHistoryDialog: React.FC<WorkspaceHistoryDialogProps> = ({
  open,
  workspace,
  onClose,
  onRestored,
}) => {
  const [versions, setVersions] = useState<PublishedWorkspaceVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !workspace) return;
    setLoading(true);
    setError('');
    void listPublishedWorkspaceHistory(workspace.id)
      .then(setVersions)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to load history'))
      .finally(() => setLoading(false));
  }, [open, workspace]);

  const handleRestore = async (version: PublishedWorkspaceVersion) => {
    if (!workspace) return;
    if (!window.confirm(`Restore published version ${version.versionNumber}?`)) return;
    setRestoreId(version.id);
    setError('');
    try {
      await restorePublishedWorkspaceVersion(workspace.id, version.id);
      await onRestored();
      const refreshed = await listPublishedWorkspaceHistory(workspace.id);
      setVersions(refreshed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to restore version');
    } finally {
      setRestoreId(null);
    }
  };

  return (
    <Dialog open={open} onClose={restoreId ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Published history</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <List disablePadding>
            {versions.map((version, index) => (
              <ListItem
                key={version.id}
                divider
                secondaryAction={
                  workspace?.role === 'owner' && index > 0 ? (
                    <Button
                      size="small"
                      disabled={Boolean(restoreId)}
                      onClick={() => void handleRestore(version)}
                    >
                      {restoreId === version.id ? 'Restoring…' : 'Restore'}
                    </Button>
                  ) : undefined
                }
              >
                <ListItemText
                  primary={`Version ${version.versionNumber}${index === 0 ? ' · Current' : ''}`}
                  secondary={`${version.publisherName} · ${new Date(version.createdAt).toLocaleString()}${
                    version.note ? ` · ${version.note}` : ''
                  }`}
                />
              </ListItem>
            ))}
          </List>
        )}
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={Boolean(restoreId)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspaceHistoryDialog;
