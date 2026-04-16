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
  IconButton,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';

import type { Workspace } from '../types';
import {
  addWorkspaceCollaborator,
  fetchUserDirectory,
  listWorkspaceCollaborators,
  removeWorkspaceCollaborator,
  type DirectoryUser,
  type WorkspaceCollaborator,
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
}

const WorkspaceShareDialog: React.FC<WorkspaceShareDialogProps> = ({ open, workspace, onClose }) => {
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [collaboratorsError, setCollaboratorsError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const [options, setOptions] = useState<DirectoryUser[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const [selected, setSelected] = useState<DirectoryUser[]>([]);
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null);

  const workspaceId = workspace?.id;

  const loadCollaborators = useCallback(async () => {
    if (!workspaceId) return;
    setCollaboratorsLoading(true);
    setCollaboratorsError(null);
    try {
      const list = await listWorkspaceCollaborators(workspaceId);
      setCollaborators(list);
    } catch (e) {
      setCollaboratorsError(e instanceof Error ? e.message : 'Failed to load collaborators');
    } finally {
      setCollaboratorsLoading(false);
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
      setInviteRole('editor');
      setInviteError(null);
    }
  }, [open]);

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
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Failed to share workspace');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRemove = async (targetUserId: string) => {
    if (!workspaceId) return;
    setRemoveBusyId(targetUserId);
    try {
      await removeWorkspaceCollaborator(workspaceId, targetUserId);
      await loadCollaborators();
    } catch {
      // keep list; user can retry
    } finally {
      setRemoveBusyId(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <span>Share workspace</span>
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
          People with access
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
                    {c.role}
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
            <ToggleButton value="editor">Editor</ToggleButton>
            <ToggleButton value="viewer">Viewer</ToggleButton>
          </ToggleButtonGroup>
        </Box>

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
          {inviteBusy ? <CircularProgress size={22} color="inherit" /> : 'Share'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspaceShareDialog;
