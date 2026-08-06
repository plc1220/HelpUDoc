import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
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
  fetchUserDirectory,
  listWorkspaceTeams,
  publishWorkspace,
  shareWorkspaceWithAudience,
  type DirectoryUser,
  type WorkspaceNamedGrantRole,
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
  const [selectedPeople, setSelectedPeople] = useState<DirectoryUser[]>([]);
  const [peopleOptions, setPeopleOptions] = useState<DirectoryUser[]>([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [namedRole, setNamedRole] = useState<WorkspaceNamedGrantRole>('contributor');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isPrivate = workspace?.visibility !== 'team';

  useEffect(() => {
    if (!open) {
      setSelectedPeople([]);
      setPeopleOptions([]);
      setPeopleQuery('');
      setTeams([]);
      setTeamId('');
      setNamedRole('contributor');
      setNote('');
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !isPrivate || peopleQuery.trim().length < 2) {
      setPeopleOptions([]);
      setPeopleLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPeopleLoading(true);
      void fetchUserDirectory(peopleQuery.trim())
        .then((users) => {
          if (!cancelled) setPeopleOptions(users);
        })
        .catch(() => {
          if (!cancelled) setPeopleOptions([]);
        })
        .finally(() => {
          if (!cancelled) setPeopleLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isPrivate, open, peopleQuery]);

  useEffect(() => {
    if (!open || !isPrivate) return;
    setTeamsLoading(true);
    void listWorkspaceTeams()
      .then((items) => {
        setTeams(items);
        if (items.length === 1) setTeamId(items[0].id);
      })
      .catch(() => setTeams([]))
      .finally(() => setTeamsLoading(false));
  }, [isPrivate, open]);

  const canSubmit = useMemo(() => {
    if (!workspace || busy) return false;
    if (!isPrivate) return true;
    return (Boolean(teamId) || selectedPeople.length > 0) && !peopleLoading && !teamsLoading;
  }, [busy, isPrivate, peopleLoading, selectedPeople.length, teamId, teamsLoading, workspace]);

  const handleSubmit = async () => {
    if (!workspace || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onBeforePublish?.(workspace);
      if (isPrivate) {
        await shareWorkspaceWithAudience(workspace.id, {
          userIds: selectedPeople.map((person) => person.id),
          teamId: teamId || undefined,
          role: namedRole,
        });
      } else {
        await publishWorkspace(workspace.id, { note: note.trim() || undefined });
      }
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
      <DialogTitle>{isPrivate ? 'Share workspace' : 'Lock current changes'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {isPrivate ? (
            <>
              Share <strong>{workspace?.name}</strong> as one live workspace. You can add more people later.
            </>
          ) : (
            <>
              Create an immutable locked version from the current Working version of <strong>{workspace?.name}</strong>.
              Live work continues afterward, and the locked snapshot cannot be edited.
            </>
          )}
        </Typography>

        {isPrivate ? (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Share with</Typography>
            {teamsLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={26} />
              </Box>
            ) : teams.length ? (
              <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                <InputLabel id="publish-team-label">Team (optional)</InputLabel>
                <Select
                  labelId="publish-team-label"
                  label="Team (optional)"
                  value={teamId}
                  onChange={(event) => setTeamId(String(event.target.value))}
                >
                  <MenuItem value="">No team</MenuItem>
                  {teams.map((team) => <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>)}
                </Select>
              </FormControl>
            ) : (
              <Alert severity="info" sx={{ mb: 2 }}>
                You do not belong to a team yet. You can still share with individual people.
              </Alert>
            )}
            {teamId ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                Team members will receive {namedRole === 'viewer' ? 'Viewer' : 'Contributor'} access to the
                shared workspace, including Workspace Chat and collaboration. Publisher authority remains direct-user only.
              </Alert>
            ) : null}
            <Autocomplete
              multiple
              options={peopleOptions}
              value={selectedPeople}
              inputValue={peopleQuery}
              onInputChange={(_event, value) => setPeopleQuery(value)}
              onChange={(_event, value) => setSelectedPeople(value)}
              getOptionLabel={(person) => person.email
                ? `${person.displayName} (${person.email})`
                : person.displayName}
              isOptionEqualToValue={(left, right) => left.id === right.id}
              filterOptions={(options) => options}
              filterSelectedOptions
              loading={peopleLoading}
              renderTags={(value, getTagProps) => value.map((person, index) => (
                <Chip {...getTagProps({ index })} key={person.id} size="small" label={person.displayName} />
              ))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="People"
                  placeholder="Search registered users"
                  helperText="Type at least 2 characters. You can manage access again at any time."
                />
              )}
              sx={{ mb: 2 }}
            />
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel id="shared-workspace-role-label">Access role</InputLabel>
              <Select
                labelId="shared-workspace-role-label"
                label="Access role"
                value={namedRole}
                onChange={(event) => setNamedRole(event.target.value as WorkspaceNamedGrantRole)}
              >
                <MenuItem value="viewer">Viewer</MenuItem>
                <MenuItem value="contributor">Contributor</MenuItem>
                <MenuItem value="publisher">Publisher</MenuItem>
              </Select>
            </FormControl>
            <Alert severity="info" sx={{ mb: 2 }}>
              Contributors can edit shared content directly or work privately and submit changes for review.
              Publishers can also approve submissions and create immutable locked versions.
            </Alert>
            {!teamId && selectedPeople.length === 0 ? (
              <Alert severity="warning" sx={{ mt: 2 }}>
                Choose at least one team or person before sharing.
              </Alert>
            ) : null}
          </>
        ) : (
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
        )}

        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {busy ? <CircularProgress size={22} color="inherit" /> : isPrivate ? 'Share workspace' : 'Lock current changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspacePublishDialog;
