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
  Typography,
} from '@mui/material';

import type { Workspace } from '../types';
import {
  fetchUserDirectory,
  listWorkspaceTeams,
  publishWorkspace,
  shareWorkspaceWithSelectedPeople,
  type DirectoryUser,
  type WorkspaceAudienceAction,
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

const ACTION_COPY: Record<WorkspaceAudienceAction, { title: string; description: string }> = {
  share_selected: {
    title: 'Share privately',
    description: 'Create a Team Workspace visible only to selected people. No immutable version is published yet.',
  },
  publish_selected: {
    title: 'Publish to selected people',
    description: 'Create a Team Workspace for named people and publish its first immutable version.',
  },
  publish_team: {
    title: 'Publish to team',
    description: 'Create a Team Workspace for everyone in the selected team and publish its first immutable version.',
  },
};

const WorkspacePublishDialog: React.FC<WorkspacePublishDialogProps> = ({
  open,
  workspace,
  onClose,
  onBeforePublish,
  onPublished,
}) => {
  const [action, setAction] = useState<WorkspaceAudienceAction>('share_selected');
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<DirectoryUser[]>([]);
  const [peopleOptions, setPeopleOptions] = useState<DirectoryUser[]>([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [namedRole, setNamedRole] = useState<WorkspaceNamedGrantRole>('viewer');
  const [note, setNote] = useState('');
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstPublication = !workspace?.linkedTeamWorkspaceId;
  const firstImmutableVersion = workspace?.currentPublishedVersionNumber == null;
  const selectedPeopleAction = firstPublication && action !== 'publish_team';
  const publishesVersion = !firstPublication || action !== 'share_selected';

  useEffect(() => {
    if (!open) {
      setAction('share_selected');
      setTeamId('');
      setSelectedPeople([]);
      setPeopleOptions([]);
      setPeopleQuery('');
      setNamedRole('viewer');
      setNote('');
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !firstPublication || action !== 'publish_team') return;
    setLoadingTeams(true);
    void listWorkspaceTeams()
      .then((items) => {
        setTeams(items);
        if (items.length === 1) setTeamId(items[0].id);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to list teams'))
      .finally(() => setLoadingTeams(false));
  }, [action, firstPublication, open]);

  useEffect(() => {
    if (!open || !selectedPeopleAction || peopleQuery.trim().length < 2) {
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
  }, [open, peopleQuery, selectedPeopleAction]);

  const canSubmit = useMemo(() => {
    if (!workspace || busy) return false;
    if (!firstPublication) return true;
    if (action === 'publish_team') return Boolean(teamId) && !loadingTeams;
    return selectedPeople.length > 0 && !peopleLoading;
  }, [action, busy, firstPublication, loadingTeams, peopleLoading, selectedPeople.length, teamId, workspace]);

  const handleSubmit = async () => {
    if (!workspace || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onBeforePublish?.(workspace);
      if (firstPublication && action === 'share_selected') {
        await shareWorkspaceWithSelectedPeople(workspace.id, {
          userIds: selectedPeople.map((person) => person.id),
          role: namedRole,
        });
      } else if (firstPublication && action === 'publish_selected') {
        await publishWorkspace(workspace.id, {
          audience: 'selected_people',
          userIds: selectedPeople.map((person) => person.id),
          role: namedRole,
          note: note.trim() || undefined,
        });
      } else if (firstPublication) {
        await publishWorkspace(workspace.id, {
          audience: 'team',
          teamId,
          note: note.trim() || undefined,
        });
      } else {
        await publishWorkspace(workspace.id, { note: note.trim() || undefined });
      }
      await onPublished();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update workspace sharing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {firstPublication ? 'Share or publish workspace' : firstImmutableVersion ? 'Publish first version' : 'Publish changes'}
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {firstPublication ? (
            <>Choose who can access <strong>{workspace?.name}</strong> and whether to publish an immutable version.</>
          ) : firstImmutableVersion ? (
            <>Publish the first immutable version of <strong>{workspace?.name}</strong>.</>
          ) : (
            <>Publish the latest private changes from <strong>{workspace?.name}</strong>.</>
          )}
        </Typography>

        {firstPublication ? (
          <RadioGroup
            value={action}
            onChange={(event) => {
              setAction(event.target.value as WorkspaceAudienceAction);
              setError('');
            }}
            sx={{ gap: 1, mb: 2 }}
          >
            {(Object.keys(ACTION_COPY) as WorkspaceAudienceAction[]).map((value) => (
              <Box key={value} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, px: 1.5, py: 0.75 }}>
                <FormControlLabel
                  value={value}
                  control={<Radio size="small" />}
                  label={<Typography variant="subtitle2">{ACTION_COPY[value].title}</Typography>}
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 4 }}>
                  {ACTION_COPY[value].description}
                </Typography>
              </Box>
            ))}
          </RadioGroup>
        ) : null}

        {selectedPeopleAction ? (
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
                  label="Selected people"
                  placeholder="Search registered users"
                  helperText="Type at least 2 characters. Workspace access does not change Team membership."
                />
              )}
              sx={{ mb: 2 }}
            />
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel id="named-workspace-role-label">Access role</InputLabel>
              <Select
                labelId="named-workspace-role-label"
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
              New shared workspaces use Review mode. Contributors cannot publish; Publisher is a direct named-user role.
            </Alert>
          </>
        ) : null}

        {firstPublication && action === 'publish_team' ? (
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
              You need to belong to a team before publishing to that team. You can still share or publish to selected people.
            </Alert>
          )
        ) : null}

        {publishesVersion ? (
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
        ) : null}

        <Alert severity="info">
          Your Private Workspace remains owner-only. Sharing creates a separate Team Workspace. Conversations, agent
          activity, schedules, connections, credentials, and personal settings stay private.
        </Alert>
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {busy ? <CircularProgress size={18} color="inherit" /> : publishesVersion ? 'Publish' : 'Share'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspacePublishDialog;
