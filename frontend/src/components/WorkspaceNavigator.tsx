import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { DeleteOutline, UnfoldMore } from '@mui/icons-material';
import WorkspaceList from './WorkspaceList';
import { permanentlyDeleteWorkspace, restoreWorkspace } from '../services/workspaceApi';
import type { Workspace } from '../types';

type Props = ComponentProps<typeof WorkspaceList> & {
  storageKey: string;
  search: string;
  onRefresh: () => Promise<unknown>;
};
const readIds = (key: string): string[] => {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
};
const saveIds = (key: string, ids: string[]) => { try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* preferences are best effort */ } };

export default function WorkspaceNavigator({ storageKey, search, onRefresh, ...props }: Props) {
  const { workspaces, selectedWorkspace, onSelectWorkspace } = props;
  const [pinned, setPinned] = useState(() => readIds(`${storageKey}.pinned`));
  const [recent, setRecent] = useState(() => readIds(`${storageKey}.recent`));
  const [view, setView] = useState('recent');
  const [filter, setFilter] = useState('all');
  const [switcher, setSwitcher] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSwitcher((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const selectedId = selectedWorkspace?.status !== 'trashed' ? selectedWorkspace?.id : undefined;
  useEffect(() => {
    if (!selectedId) return;
    setRecent((ids) => {
      const next = [selectedId, ...ids.filter((id) => id !== selectedId)].slice(0, 30);
      saveIds(`${storageKey}.recent`, next); return next;
    });
  }, [selectedId, storageKey]);
  const active = workspaces.filter((workspace) => workspace.status !== 'trashed');
  const trash = workspaces.filter((workspace) => workspace.status === 'trashed' && workspace.role === 'owner');
  const ordered = [...active].sort((a, b) => {
    const rank = (id: string) => recent.includes(id) ? recent.indexOf(id) : 1000;
    return rank(a.id) - rank(b.id);
  });
  const matching = ordered.filter((workspace) => workspace.name.toLowerCase().includes(search.toLowerCase())
    && (filter === 'all' || (filter === 'shared' ? workspace.visibility === 'team' && workspace.status !== 'unshared' : workspace.visibility !== 'team' || workspace.status === 'unshared')));
  const togglePin = (workspace: Workspace) => setPinned((ids) => {
    const next = ids.includes(workspace.id) ? ids.filter((id) => id !== workspace.id) : [...ids, workspace.id];
    saveIds(`${storageKey}.pinned`, next); return next;
  });
  const renderList = (items: Workspace[]) => <WorkspaceList {...props} workspaces={items} pinnedIds={pinned} onTogglePin={togglePin} flat />;
  const run = async (ids: string[], remove: boolean) => {
    setBusy(true); setError('');
    const failures: string[] = [];
    for (const id of ids) {
      try { await (remove ? permanentlyDeleteWorkspace(id) : restoreWorkspace(id)); }
      catch (cause) { failures.push(`${workspaces.find((w) => w.id === id)?.name || id}: ${cause instanceof Error ? cause.message : 'Request failed'}`); }
    }
    try { await onRefresh(); } catch { failures.push('Could not refresh workspaces. Please reopen Trash.'); }
    setSelected([]); setConfirmIds([]); setBusy(false); setError(failures.join('\n'));
  };
  return <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
    <Button onClick={() => setSwitcher(true)} endIcon={<UnfoldMore />} sx={{ justifyContent: 'space-between', textTransform: 'none', mb: 1 }} aria-label="Switch workspace">
      <Typography noWrap sx={{ minWidth: 0, textAlign: 'left' }}>{selectedWorkspace?.name || 'Switch workspace'}</Typography>
      <Typography variant="caption" sx={{ whiteSpace: 'nowrap', ml: 1 }}>{/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'}</Typography>
    </Button>
    <ToggleButtonGroup exclusive size="small" value={view} onChange={(_, value) => value && setView(value)} fullWidth sx={{ '& .MuiToggleButton-root': { whiteSpace: 'nowrap', fontSize: 12, textTransform: 'none' } }}>
      <ToggleButton value="recent">Recent</ToggleButton><ToggleButton value="all">All workspaces</ToggleButton>
    </ToggleButtonGroup>
    {(view === 'all' || search) && <ToggleButtonGroup exclusive size="small" value={filter} onChange={(_, value) => value && setFilter(value)} fullWidth sx={{ my: 1 }}>
      <ToggleButton value="all">All</ToggleButton><ToggleButton value="private">Private</ToggleButton><ToggleButton value="shared">Shared</ToggleButton>
    </ToggleButtonGroup>}
    {view === 'recent' && !search ? <>
      {pinned.some((id) => active.some((w) => w.id === id)) && <><Typography variant="overline">Pinned</Typography>{renderList(ordered.filter((w) => pinned.includes(w.id)))}</>}
      <Typography variant="overline">Recent</Typography>{renderList(ordered.filter((w) => !pinned.includes(w.id)).slice(0, 8))}
    </> : renderList(matching)}
    {!active.length && <Typography color="text.secondary" sx={{ py: 2 }}>Create a workspace to get started.</Typography>}
    {(view === 'all' || search) && !matching.length && <Typography sx={{ py: 2 }}>No matching workspaces.</Typography>}
    <Button startIcon={<DeleteOutline />} onClick={() => { setTrashOpen(true); setError(''); }} sx={{ mt: 'auto', justifyContent: 'flex-start' }}>Trash ({trash.length})</Button>
    <Dialog open={switcher} onClose={() => setSwitcher(false)} fullWidth maxWidth="sm" aria-labelledby="workspace-switch-title">
      <DialogTitle id="workspace-switch-title">Switch workspace</DialogTitle>
      <DialogContent sx={{ minHeight: 320 }}>
        <Autocomplete options={ordered} getOptionLabel={(workspace) => workspace.name} getOptionKey={(workspace) => workspace.id} autoHighlight openOnFocus
          onChange={(_, workspace) => { if (workspace) { onSelectWorkspace(workspace); setSwitcher(false); } }}
          renderOption={(optionProps, workspace) => <li {...optionProps} key={workspace.id}><ListItemText primary={workspace.name} secondary={`${pinned.includes(workspace.id) ? 'Pinned · ' : ''}${workspace.visibility === 'team' && workspace.status !== 'unshared' ? 'Shared' : 'Private'}`} /></li>}
          renderInput={(params) => <TextField {...params} autoFocus label="Search workspaces" margin="dense" />} />
      </DialogContent><DialogActions><Button onClick={() => setSwitcher(false)}>Close</Button></DialogActions>
    </Dialog>
    <Dialog open={trashOpen} onClose={() => { if (!busy) { setTrashOpen(false); setSelected([]); } }} fullWidth maxWidth="md" aria-labelledby="workspace-trash-title">
      <DialogTitle id="workspace-trash-title">Trash ({trash.length})</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary">Workspaces are kept for 30 days. Restored shared workspaces are private until you re-share them.</Typography>
        {error && <Alert severity="error" sx={{ my: 1, whiteSpace: 'pre-line' }}>{error}</Alert>}
        {!!trash.length && <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Checkbox checked={trash.length > 0 && trash.every((w) => selected.includes(w.id))} indeterminate={selected.length > 0 && selected.length < trash.length} disabled={busy} inputProps={{ 'aria-label': 'Select all trashed workspaces' }} onChange={(_, checked) => setSelected(checked ? trash.map((w) => w.id) : [])} />
          <Button disabled={!selected.length || busy} onClick={() => void run(selected, false)}>Restore selected</Button>
          <Button color="error" disabled={!selected.length || busy} onClick={() => setConfirmIds(selected)}>Delete selected</Button>
        </Stack>}
        <List>{trash.map((workspace) => <ListItem key={workspace.id} disableGutters sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Checkbox checked={selected.includes(workspace.id)} disabled={busy} inputProps={{ 'aria-label': `Select ${workspace.name}` }} onChange={(_, checked) => setSelected((ids) => checked ? [...ids, workspace.id] : ids.filter((id) => id !== workspace.id))} />
          <ListItemText primary={workspace.name} secondary={`Deleted ${workspace.trashedAt ? new Date(workspace.trashedAt).toLocaleDateString() : 'recently'}${workspace.purgeAfter ? ` · ${Math.max(0, Math.ceil((new Date(workspace.purgeAfter).getTime() - Date.now()) / 86400000))} days remaining` : ''}`} sx={{ minWidth: 180 }} />
          <Button disabled={busy} onClick={() => void run([workspace.id], false)}>Restore</Button>
          <Button color="error" disabled={busy} onClick={() => setConfirmIds([workspace.id])}>Delete permanently</Button>
        </ListItem>)}</List>
        {!trash.length && <Typography sx={{ py: 4 }}>Trash is empty.</Typography>}
      </DialogContent>
      <DialogActions><Button color="error" disabled={!trash.length || busy} onClick={() => setConfirmIds(trash.map((w) => w.id))}>Empty trash</Button><Button disabled={busy} onClick={() => setTrashOpen(false)}>Close</Button></DialogActions>
    </Dialog>
    <Dialog open={confirmIds.length > 0} onClose={() => !busy && setConfirmIds([])} aria-labelledby="permanent-delete-title">
      <DialogTitle id="permanent-delete-title">Permanently delete {confirmIds.length} workspace{confirmIds.length === 1 ? '' : 's'}?</DialogTitle>
      <DialogContent><Typography>This removes their files, conversations, and version history. This cannot be undone.</Typography>
        <List dense>{confirmIds.map((id) => <ListItem key={id}><ListItemText primary={workspaces.find((w) => w.id === id)?.name || id} /></ListItem>)}</List>
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setConfirmIds([])}>Cancel</Button><Button color="error" variant="contained" disabled={busy} onClick={() => void run(confirmIds, true)}>{busy ? 'Deleting…' : 'Delete permanently'}</Button></DialogActions>
    </Dialog>
  </Box>;
}
