import React from 'react';
import { Drawer, Box, IconButton, Typography, TextField, Button } from '@mui/material';
import { ChevronLeft, Add } from '@mui/icons-material';
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
          backgroundColor: '#f8fafc',
          borderRight: '1px solid #e2e8f0',
        },
      }}
      variant="persistent"
      anchor="left"
      open={open}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 2.5, gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Workspaces
          </Typography>
          <IconButton onClick={handleDrawerClose} size="small" sx={{ border: '1px solid #e2e8f0', borderRadius: 2 }}>
            <ChevronLeft fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <TextField
            placeholder="New workspace"
            variant="outlined"
            fullWidth
            size="small"
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            InputProps={{
              sx: {
                borderRadius: 2,
                backgroundColor: 'common.white',
              },
            }}
          />
          <Button
            variant="contained"
            color="primary"
            fullWidth
            onClick={handleCreateWorkspace}
            startIcon={<Add />}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
          >
            Create
          </Button>
        </Box>

        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Box sx={{ flexGrow: 1, overflowY: 'auto', pr: 1 }}>
            <WorkspaceList
              workspaces={workspaces}
              selectedWorkspace={selectedWorkspace}
              onSelectWorkspace={onSelectWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
            />
          </Box>
        </Box>
      </Box>
    </Drawer>
  );
};

export default CollapsibleDrawer;
