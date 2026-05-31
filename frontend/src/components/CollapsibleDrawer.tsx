import React from 'react';
import { Drawer, Box, IconButton, TextField } from '@mui/material';
import { Add, ChevronLeft, Settings, LightMode, DarkMode, Logout } from '@mui/icons-material';
import WorkspaceList from './WorkspaceList';
import type { Workspace } from '../types';
import type { PaletteMode } from '@mui/material';

interface CollapsibleDrawerProps {
  open: boolean;
  handleDrawerClose: () => void;
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  workspaceSearchQuery: string;
  setWorkspaceSearchQuery: (name: string) => void;
  handleDeleteWorkspace: (id: string) => void;
  onShareWorkspace?: (workspace: Workspace) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
  onCreateWorkspace: () => void | Promise<void>;
  onOpenSettings: () => void;
  colorMode: PaletteMode;
  onToggleColorMode: () => void;
  onSignOut?: () => void;
}

const drawerWidth = 280;

const CollapsibleDrawer: React.FC<CollapsibleDrawerProps> = ({
  open,
  handleDrawerClose,
  workspaces,
  selectedWorkspace,
  workspaceSearchQuery,
  setWorkspaceSearchQuery,
  handleDeleteWorkspace,
  onShareWorkspace,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenSettings,
  colorMode,
  onToggleColorMode,
  onSignOut,
}) => {
  const handleOpenSettingsClick = () => {
    handleDrawerClose();
    onOpenSettings();
  };

  return (
    <Drawer
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          boxSizing: 'border-box',
          backgroundColor: (theme) => theme.palette.background.default,
          borderRight: (theme) => `1px solid ${theme.palette.divider}`,
        },
      }}
      variant="persistent"
      anchor="left"
      open={open}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden',
          p: 2.5,
          gap: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <IconButton
            onClick={() => {
              void onCreateWorkspace();
            }}
            size="small"
            title="New workspace"
            aria-label="Create workspace"
            sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2 }}
          >
            <Add fontSize="small" />
          </IconButton>
          <IconButton
            onClick={handleDrawerClose}
            size="small"
            sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2 }}
          >
            <ChevronLeft fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flexShrink: 0 }}>
          <TextField
            placeholder="Search workspaces"
            variant="outlined"
            fullWidth
            size="small"
            value={workspaceSearchQuery}
            onChange={(e) => setWorkspaceSearchQuery(e.target.value)}
            InputProps={{
              sx: {
                borderRadius: 2,
                backgroundColor: (theme) => theme.palette.background.paper,
              },
            }}
          />
        </Box>

        <Box
          sx={{
            flex: '1 1 0%',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              pb: 1,
            }}
          >
            <WorkspaceList
              workspaces={workspaces}
              selectedWorkspace={selectedWorkspace}
              onSelectWorkspace={onSelectWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              onShareWorkspace={onShareWorkspace}
            />
          </Box>
          <Box
            sx={{
              flexShrink: 0,
              borderTop: (theme) => `1px solid ${theme.palette.divider}`,
              pt: 1.25,
              mt: 1.25,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <IconButton
              onClick={onToggleColorMode}
              title={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              size="small"
              sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2 }}
            >
              {colorMode === 'dark' ? <LightMode fontSize="small" /> : <DarkMode fontSize="small" />}
            </IconButton>
            <IconButton
              onClick={handleOpenSettingsClick}
              title="Agent settings"
              aria-label="Agent settings"
              size="small"
              sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2 }}
            >
              <Settings fontSize="small" />
            </IconButton>
            {onSignOut ? (
              <IconButton
                onClick={onSignOut}
                title="Logout"
                aria-label="Logout"
                size="small"
                sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2, ml: 'auto' }}
              >
                <Logout fontSize="small" />
              </IconButton>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Drawer>
  );
};

export default CollapsibleDrawer;
