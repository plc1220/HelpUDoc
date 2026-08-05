import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import GroupsIcon from '@mui/icons-material/Groups';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';

import type { Workspace } from '../types';
import {
  addWorkspaceCollaborator,
  addWorkspaceTeam,
  fetchUserDirectory,
  listWorkspaceCollaborators,
  listWorkspaceTeams,
  removeWorkspaceCollaborator,
  removeWorkspaceTeam,
  updateWorkspaceEditingPolicy,
  type DirectoryUser,
  type WorkspaceAccessTeam,
  type WorkspaceEditingPolicy,
  type WorkspaceCollaborator,
  type WorkspaceTeam,
} from '../services/workspaceApi';

const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export interface WorkspaceShareDialogProps {
  open: boolean;
  workspace: Workspace | null;
  onClose: () => void;
  onWorkspaceChanged?: () => void | Promise<unknown>;
}

const WorkspaceShareDialog: React.FC<WorkspaceShareDialogProps> = ({
  open,
  workspace,
  onClose,
  onWorkspaceChanged,
}) => {
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [accessTeams, setAccessTeams] = useState<WorkspaceAccessTeam[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [collaboratorsError, setCollaboratorsError] = useState<string | null>(null);
  const [availableTeams, setAvailableTeams] = useState<WorkspaceTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamBusyId, setTeamBusyId] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const [options, setOptions] = useState<DirectoryUser[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const [selected, setSelected] = useState<DirectoryUser[]>([]);
  const [inviteRole, setInviteRole] = useState<'editor' | 'contributor' | 'viewer'>('contributor');
  const [editingPolicy, setEditingPolicy] = useState<WorkspaceEditingPolicy>('direct');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null);

  const workspaceId = workspace?.id;

  const loadCollaborators = useCallback(async () => {
    if (!workspaceId) return;
    setCollaboratorsLoading(true);
    setCollaboratorsError(null);
    try {
      const access = await listWorkspaceCollaborators(workspaceId);
      setCollaborators(access.directCollaborators ?? access.collaborators ?? []);
      setAccessTeams(access.teams ?? []);
    } catch (e) {
      setCollaboratorsError(e instanceof Error ? e.message : 'Failed to load collaborators');
    } finally {
      setCollaboratorsLoading(false);
    }
  }, [workspaceId]);

  const loadAvailableTeams = useCallback(async () => {
    if (!workspaceId) return;
    setTeamsLoading(true);
    setTeamError(null);
    try {
      setAvailableTeams(await listWorkspaceTeams());
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : 'Failed to load teams');
    } finally {
      setTeamsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!open || !workspaceId) {
      return;
    }
    void loadCollaborators();
  }, [open, workspaceId, loadCollaborators]);

  useEffect(() => {
    if (!open) {
      setSearchInput('');
      setOptions([]);
      setSelected([]);
      setAccessTeams([]);
      setAvailableTeams([]);
      setSelectedTeamId('');
      setInviteRole('contributor');
      setEditingPolicy(workspace?.editingPolicy || 'direct');
      setInviteError(null);
      setTeamError(null);
    }
  }, [open, workspace?.editingPolicy]);

  useEffect(() => {
    if (open && workspaceId) {
      void loadAvailableTeams();
    }
  }, [open, workspaceId, loadAvailableTeams]);

  useEffect(() => {
    if (!open || !workspaceId) {
      return;
    }
    const q = debouncedSearch.trim();
    if (q.length < 2) {
      setOptions([]);
      setOptionsLoading(false);
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    void fetchUserDirectory(q)
      .then((users) => {
        if (!cancelled) {
          setOptions(users);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOptions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOptionsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, debouncedSearch]);

  const memberIds = useMemo(() => new Set(collaborators.map((c) => c.userId)), [collaborators]);

  const filteredOptions = useMemo(
    () => options.filter((u) => !memberIds.has(u.id)),
    [options, memberIds],
  );

  const teamOptions = useMemo(
    () => availableTeams.filter((team) => !accessTeams.some((accessTeam) => accessTeam.id === team.id)),
    [accessTeams, availableTeams],
  );

  const handleInvite = async () => {
    if (!workspaceId || selected.length === 0) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      for (const user of selected) {
        await addWorkspaceCollaborator(workspaceId, { userId: user.id, role: inviteRole });
      }
      setSelected([]);
      await loadCollaborators();
      await onWorkspaceChanged?.();
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Failed to update workspace access');
    } finally {
      setInviteBusy(false);
    }
  };

  const handlePolicyChange = async (nextPolicy: WorkspaceEditingPolicy) => {
    if (!workspaceId || nextPolicy === editingPolicy) return;
    const previous = editingPolicy;
    setEditingPolicy(nextPolicy);
    setPolicyBusy(true);
    try {
      await updateWorkspaceEditingPolicy(workspaceId, nextPolicy);
      await loadCollaborators();
      await onWorkspaceChanged?.();
    } catch (e) {
      setEditingPolicy(previous);
      setInviteError(e instanceof Error ? e.message : 'Failed to update editing policy');
    } finally {
      setPolicyBusy(false);
    }
  };

  const handleRemove = async (targetUserId: string) => {
    if (!workspaceId) return;
    setRemoveBusyId(targetUserId);
    try {
      await removeWorkspaceCollaborator(workspaceId, targetUserId);
      await loadCollaborators();
      await onWorkspaceChanged?.();
    } catch {
      // keep list; user can retry
    } finally {
      setRemoveBusyId(null);
    }
  };

  const handleAddTeam = async () => {
    if (!workspaceId || !selectedTeamId) return;
    setTeamBusyId(selectedTeamId);
    setTeamError(null);
    try {
      await addWorkspaceTeam(workspaceId, selectedTeamId);
      setSelectedTeamId('');
      await Promise.all([loadCollaborators(), loadAvailableTeams()]);
      await onWorkspaceChanged?.();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : 'Failed to add team access');
    } finally {
      setTeamBusyId(null);
    }
  };

  const handleRemoveTeam = async (teamId: string) => {
    if (!workspaceId) return;
    setTeamBusyId(teamId);
    setTeamError(null);
    try {
      await removeWorkspaceTeam(workspaceId, teamId);
      await Promise.all([loadCollaborators(), loadAvailableTeams()]);
      await onWorkspaceChanged?.();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : 'Failed to remove team access');
    } finally {
      setTeamBusyId(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <span>Manage shared workspace access</span>
        <IconButton aria-label="close" onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {workspace ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {workspace.name}
          </Typography>
        ) : null}

        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Editing policy
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={editingPolicy}
          disabled={policyBusy}
          onChange={(_event, value) => {
            if (value) void handlePolicyChange(value as WorkspaceEditingPolicy);
          }}
          sx={{ mb: 1 }}
        >
          <ToggleButton value="direct">Freeflow</ToggleButton>
          <ToggleButton value="review">Review</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3 }}>
          {editingPolicy === 'direct'
            ? 'Contributors edit the live working version directly.'
            : 'Contributors submit changes for review before they reach the working version.'}
        </Typography>

        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Teams with access
        </Typography>
        {accessTeams.length ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
            {accessTeams.map((team) => (
              <Box
                key={team.id}
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, py: 0.5 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                  <GroupsIcon fontSize="small" color="action" />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{team.name}</Typography>
                    <Typography variant="caption" color="text.secondary">Team members have Viewer access</Typography>
                  </Box>
                </Box>
                <IconButton
                  size="small"
                  aria-label={`Remove ${team.name} team access`}
                  disabled={teamBusyId === team.id}
                  onClick={() => void handleRemoveTeam(team.id)}
                >
                  {teamBusyId === team.id ? <CircularProgress size={20} /> : <RemoveCircleOutlineIcon fontSize="small" />}
                </IconButton>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            No team currently has access.
          </Typography>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
          <FormControl fullWidth size="small">
            <InputLabel id="workspace-team-access-label">Add a team</InputLabel>
            <Select
              labelId="workspace-team-access-label"
              label="Add a team"
              value={selectedTeamId}
              onChange={(event) => setSelectedTeamId(String(event.target.value))}
              disabled={teamsLoading || teamOptions.length === 0 || Boolean(teamBusyId)}
            >
              {teamOptions.map((team) => (
                <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            onClick={() => void handleAddTeam()}
            disabled={!selectedTeamId || Boolean(teamBusyId)}
            sx={{ flexShrink: 0 }}
          >
            Add team
          </Button>
        </Box>
        {teamError ? <Typography color="error" variant="body2" sx={{ mb: 2 }}>{teamError}</Typography> : null}

        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          People with direct access
        </Typography>
        {collaboratorsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={28} />
          </Box>
        ) : collaboratorsError ? (
          <Typography color="error" variant="body2" sx={{ mb: 2 }}>
            {collaboratorsError}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
            {collaborators.map((c) => (
              <Box
                key={c.userId}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  py: 0.5,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {c.displayName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {c.role === 'editor'
                      ? 'Publisher'
                      : c.role === 'contributor'
                        ? 'Contributor'
                        : c.role === 'commenter'
                          ? 'Commenter'
                          : c.role === 'owner'
                            ? 'Workspace owner'
                            : 'Viewer'}
                  </Typography>
                </Box>
                {c.role !== 'owner' ? (
                  <IconButton
                    size="small"
                    aria-label={`Remove ${c.displayName}`}
                    disabled={removeBusyId === c.userId}
                    onClick={() => void handleRemove(c.userId)}
                  >
                    {removeBusyId === c.userId ? (
                      <CircularProgress size={20} />
                    ) : (
                      <PersonRemoveIcon fontSize="small" />
                    )}
                  </IconButton>
                ) : (
                  <Box sx={{ width: 34 }} />
                )}
              </Box>
            ))}
          </Box>
        )}

        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Add people
        </Typography>
        <Autocomplete
          multiple
          options={filteredOptions}
          value={selected}
          onChange={(_e, v) => setSelected(v)}
          inputValue={searchInput}
          onInputChange={(_e, v) => setSearchInput(v)}
          getOptionLabel={(o) => (o.email ? `${o.displayName} (${o.email})` : o.displayName)}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          loading={optionsLoading}
          filterOptions={(x) => x}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Search registered users"
              placeholder="Type at least 2 characters"
              helperText={
                searchInput.trim().length > 0 && searchInput.trim().length < 2
                  ? 'Enter at least 2 characters'
                  : undefined
              }
            />
          )}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip {...getTagProps({ index })} key={option.id} size="small" label={option.displayName} />
            ))
          }
        />

        <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            Role for new members
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={inviteRole}
            onChange={(_e, v) => {
              if (v) setInviteRole(v);
            }}
          >
            <ToggleButton value="editor">Publisher</ToggleButton>
            <ToggleButton value="contributor">Contributor</ToggleButton>
            <ToggleButton value="viewer">Viewer</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Contributors edit directly in Freeflow or submit changes in Review. Publishers can also create
          immutable published versions.
        </Typography>

        {inviteError ? (
          <Typography color="error" variant="body2" sx={{ mt: 1 }}>
            {inviteError}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} color="inherit">
          Done
        </Button>
        <Button
          variant="contained"
          disabled={!workspaceId || selected.length === 0 || inviteBusy}
          onClick={() => void handleInvite()}
        >
          {inviteBusy ? <CircularProgress size={22} color="inherit" /> : 'Update access'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspaceShareDialog;
