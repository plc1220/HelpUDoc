import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme } from '@mui/material';
import CollapsibleDrawer from '../../src/components/CollapsibleDrawer';
import type { Workspace } from '../../src/types';
const initial = [
  { id: 'alpha', name: 'Alpha plan', visibility: 'private', role: 'owner', status: 'active' },
  { id: 'beta', name: 'Beta research', visibility: 'team', role: 'owner', status: 'active' },
  { id: 'old', name: 'Old draft', visibility: 'private', role: 'owner', status: 'trashed', trashedAt: '2026-09-14', purgeAfter: '2026-10-14' },
] as Workspace[];
export function Fixture() {
  const [workspaces, setWorkspaces] = useState(initial);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(true);
  return <ThemeProvider theme={createTheme()}>
    <button style={{ marginLeft: 300 }} onClick={() => setOpen(true)}>Open navigation</button>
    <p style={{ marginLeft: 300 }} aria-label="Current workspace">{selected?.name}</p>
    <CollapsibleDrawer open={open} handleDrawerClose={() => setOpen(false)} storageKey="test.navigator" workspaces={workspaces} selectedWorkspace={selected} workspaceSearchQuery={search} setWorkspaceSearchQuery={setSearch}
      onRefresh={async () => { const response = await fetch('/fixture-workspaces'); setWorkspaces(await response.json()); }}
      onSelectWorkspace={setSelected} handleDeleteWorkspace={() => {}} onLifecycleWorkspace={() => {}} onCreateWorkspace={() => {}} onOpenSettings={() => {}} colorMode="light" onToggleColorMode={() => {}} />
  </ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
