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
  FormControlLabel,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';

import type { Workspace } from '../types';
import {
  fetchUserDirectory,
  listWorkspaceTeams,
  publishWorkspace,
  shareWorkspaceWithSelectedPeople,
  type DirectoryUser,
  type WorkspaceEditingPolicy,
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
  const [audience, setAudience] = useState<'selected_people' | 'team'>('selected_people');
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [namedRole, setNamedRole] = useState<WorkspaceNamedGrantRole>('contributor');
  const [editingPolicy, setEditingPolicy] = useState<WorkspaceEditingPolicy>('direct');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isPrivate = workspace?.visibility !== 'team';

  useEffect(() => {
    if (!open) {
      setSelectedPeople([]);
      setPeopleOptions([]);
      setPeopleQuery('');
      setAudience('selected_people');
      setTeams([]);
      setTeamId('');
      setNamedRole('contributor');
      setEditingPolicy('direct');
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
    if (!open || !isPrivate || audience !== 'team') return;
    setTeamsLoading(true);
    void listWorkspaceTeams()
      .then((items) => {
        setTeams(items);
        if (items.length === 1) setTeamId(items[0].id);
      })
      .catch(() => setTeams([]))
      .finally(() => setTeamsLoading(false));
  }, [audience, isPrivate, open]);

  const canSubmit = useMemo(() => {
    if (!workspace || busy) return false;
    if (!isPrivate) return true;
    if (audience === 'team') return Boolean(teamId) && !teamsLoading;
    return selectedPeople.length > 0 && !peopleLoading;
  }, [audience, busy, isPrivate, peopleLoading, selectedPeople.length, teamId, teamsLoading, workspace]);

  const handleSubmit = async () => {
    if (!workspace || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onBeforePublish?.(workspace);
      if (isPrivate) {
        if (audience === 'team') {
          await publishWorkspace(workspace.id, {
            audience: 'team',
            teamId,
            note: note.trim() || undefined,
          });
        } else {
          await shareWorkspaceWithSelectedPeople(workspace.id, {
            userIds: selectedPeople.map((person) => person.id),
            role: namedRole,
            editingPolicy,
          });
        }
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
      <DialogTitle>{isPrivate ? 'Share workspace' : 'Create published version'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {isPrivate ? (
            <>
              Share <strong>{workspace?.name}</strong> as one live workspace. You can add more people later.
            </>
          ) : (
            <>
              Snapshot the current working revision of <strong>{workspace?.name}</strong>. Live work can continue afterward.
            </>
          )}
        </Typography>

        {isPrivate ? (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Share with</Typography>
            <RadioGroup
              row
              value={audience}
              onChange={(event) => setAudience(event.target.value as 'selected_people' | 'team')}
              sx={{ mb: 2 }}
            >
              <FormControlLabel value="selected_people" control={<Radio size="small" />} label="People" />
              <FormControlLabel value="team" control={<Radio size="small" />} label="Team" />
            </RadioGroup>
            {audience === 'team' ? (
              teamsLoading ? (
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
                    {teams.map((team) => <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>)}
                  </Select>
                </FormControl>
              ) : (
                <Alert severity="info" sx={{ mb: 2 }}>
                  You need to belong to a team before sharing with one.
                </Alert>
              )
            ) : null}
            {audience === 'selected_people' ? (
              <>
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
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Editing policy</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={editingPolicy}
              onChange={(_event, value) => {
                if (value) setEditingPolicy(value as WorkspaceEditingPolicy);
              }}
              sx={{ mb: 1.5 }}
            >
              <ToggleButton value="direct">Freeflow</ToggleButton>
              <ToggleButton value="review">Review</ToggleButton>
            </ToggleButtonGroup>
            <Alert severity="info">
              {editingPolicy === 'direct'
                ? 'Contributors edit the working version directly. The latest successful save wins.'
                : 'Contributors propose changes; the owner reviews them before they reach the working version.'}
            </Alert>
              </>
            ) : (
              <Alert severity="info" sx={{ mb: 2 }}>
                Team members will receive Viewer access to the read-only shared workspace, including Team Chat and collaboration.
              </Alert>
            )}
          </>
        ) : (
          <TextField
            label="Publication note (optional)"
            placeholder="Describe this version"
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
          {busy ? <CircularProgress size={22} color="inherit" /> : isPrivate ? 'Share workspace' : 'Create version'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspacePublishDialog;
