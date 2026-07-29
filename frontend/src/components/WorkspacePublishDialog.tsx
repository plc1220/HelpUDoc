import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';

import type { Workspace } from '../types';
import {
  listWorkspaceTeams,
  publishWorkspace,
  type WorkspaceTeam,
} from '../services/workspaceApi';

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
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [note, setNote] = useState('');
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstPublication = !workspace?.linkedTeamWorkspaceId;

  useEffect(() => {
    if (!open) {
      setTeamId('');
      setNote('');
      setError('');
      return;
    }
    if (!firstPublication) return;
    setLoadingTeams(true);
    void listWorkspaceTeams()
      .then((items) => {
        setTeams(items);
        if (items.length === 1) setTeamId(items[0].id);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to list teams'))
      .finally(() => setLoadingTeams(false));
  }, [firstPublication, open]);

  const canPublish = useMemo(
    () => Boolean(workspace && (!firstPublication || teamId) && !busy && !loadingTeams),
    [busy, firstPublication, loadingTeams, teamId, workspace],
  );

  const handlePublish = async () => {
    if (!workspace || !canPublish) return;
    setBusy(true);
    setError('');
    try {
      await onBeforePublish?.(workspace);
      await publishWorkspace(workspace.id, {
        ...(firstPublication ? { teamId } : {}),
        note: note.trim() || undefined,
      });
      await onPublished();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to publish workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{firstPublication ? 'Publish to team' : 'Publish changes'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Publish a stable version of <strong>{workspace?.name}</strong>. Your private workspace remains visible only
          to you.
        </Typography>

        {firstPublication ? (
          loadingTeams ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={26} />
            </Box>
          ) : teams.length ? (
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel id="publish-team-label">Team</InputLabel>
              <Select
                labelId="publish-team-label"
                label="Team"
                value={teamId}
                onChange={(event) => setTeamId(String(event.target.value))}
              >
                {teams.map((team) => (
                  <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              You need to belong to a team before you can publish this workspace.
            </Alert>
          )
        ) : null}

        <TextField
          label="Publication note (optional)"
          placeholder="Describe what changed"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          multiline
          minRows={2}
          fullWidth
          inputProps={{ maxLength: 1000 }}
          sx={{ mb: 2 }}
        />

        <Alert severity="info">
          Files, folders, and visible workspace artifacts will be published. Conversations, agent activity,
          schedules, connections, credentials, and personal settings stay private.
        </Alert>
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void handlePublish()} disabled={!canPublish}>
          {busy ? <CircularProgress size={18} color="inherit" /> : 'Publish'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspacePublishDialog;
