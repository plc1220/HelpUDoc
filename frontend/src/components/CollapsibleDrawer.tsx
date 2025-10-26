import React from 'react';
import { Drawer, Box, IconButton, Typography, TextField, Button } from '@mui/material';
import { ChevronLeft } from '@mui/icons-material';
import WorkspaceList from './WorkspaceList';
import type { Workspace } from '../types';

interface CollapsibleDrawerProps {
  open: boolean;
  handleDrawerClose: () => void;
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  newWorkspaceName: string;
  setNewWorkspaceName: (name: string) => void;
  handleCreateWorkspace: () => void;
  handleDeleteWorkspace: (id: string) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
}

const drawerWidth = 280;

const CollapsibleDrawer: React.FC<CollapsibleDrawerProps> = ({
  open,
  handleDrawerClose,
  workspaces,
  selectedWorkspace,
  newWorkspaceName,
  setNewWorkspaceName,
  handleCreateWorkspace,
  handleDeleteWorkspace,
  onSelectWorkspace,
}) => {
  return (
    <Drawer
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          boxSizing: 'border-box',
        },
      }}
      variant="persistent"
      anchor="left"
      open={open}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', p: 1, justifyContent: 'flex-end' }}>
          <IconButton onClick={handleDrawerClose}>
            <ChevronLeft />
          </IconButton>
        </Box>
        <Box sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>Workspace</Typography>
          <TextField
            label="New Workspace"
            variant="outlined"
            fullWidth
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            sx={{ mb: 2 }}
          />
          <Button variant="contained" onClick={handleCreateWorkspace} fullWidth>
            + New Workspace
          </Button>
        </Box>
        <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
          <WorkspaceList
            workspaces={workspaces}
            selectedWorkspace={selectedWorkspace}
            onSelectWorkspace={onSelectWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
          />
        </Box>
      </Box>
    </Drawer>
  );
};

export default CollapsibleDrawer;