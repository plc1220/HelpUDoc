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
  onViewVersion?: (
    workspace: Workspace,
    version: PublishedWorkspaceVersion,
  ) => void | Promise<void>;
};

const WorkspaceHistoryDialog: React.FC<WorkspaceHistoryDialogProps> = ({
  open,
  workspace,
  onClose,
  onRestored,
  onViewVersion,
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
    if (!window.confirm(`Restore locked version ${version.versionNumber}?`)) return;
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
      <DialogTitle>Locked history</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          versions.length ? (
            <List disablePadding>
              {versions.map((version, index) => (
                <ListItem
                  key={version.id}
                  divider
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {onViewVersion && workspace ? (
                        <Button
                          size="small"
                          disabled={Boolean(restoreId)}
                          aria-label={`View locked version ${version.versionNumber} as read-only`}
                          onClick={() => void onViewVersion(workspace, version)}
                        >
                          View
                        </Button>
                      ) : null}
                      {workspace?.role === 'owner' && !version.isCurrent ? (
                        <Button
                          size="small"
                          disabled={Boolean(restoreId)}
                          onClick={() => void handleRestore(version)}
                        >
                          {restoreId === version.id ? 'Restoring…' : 'Restore'}
                        </Button>
                      ) : null}
                    </Box>
                  }
                >
                  <ListItemText
                    primary={`Version ${version.versionNumber}${version.isCurrent
                      ? ' · Current'
                      : workspace?.currentPublishedVersionId == null && index === 0
                        ? ' · Withdrawn'
                        : ''}`}
                    secondary={`${version.publisherName} · ${new Date(version.createdAt).toLocaleString()}${
                      version.note ? ` · ${version.note}` : ''
                    } · Immutable snapshot`}
                  />
                </ListItem>
              ))}
            </List>
          ) : (
            <Alert severity="info">
              This workspace has been shared, but no immutable version has been locked yet.
            </Alert>
          )
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
