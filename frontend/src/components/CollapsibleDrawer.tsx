import React from 'react';
import { Drawer, Box, IconButton, Typography, TextField, Button, Switch } from '@mui/material';
import { ChevronLeft, Add, Settings, LightMode, DarkMode, Logout } from '@mui/icons-material';
import WorkspaceList from './WorkspaceList';
import type { Workspace } from '../types';
import type { PaletteMode } from '@mui/material';

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
  newWorkspaceName,
  setNewWorkspaceName,
  handleCreateWorkspace,
  handleDeleteWorkspace,
  onSelectWorkspace,
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
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 2.5, gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Workspaces
          </Typography>
          <IconButton
            onClick={handleDrawerClose}
            size="small"
            sx={{ border: (theme) => `1px solid ${theme.palette.divider}`, borderRadius: 2 }}
          >
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
                backgroundColor: (theme) => theme.palette.background.paper,
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
          <Box
            sx={{
              borderTop: (theme) => `1px solid ${theme.palette.divider}`,
              pt: 2,
              mt: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 1.5,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                p: 1.5,
                borderRadius: 2,
                border: (theme) => `1px solid ${theme.palette.divider}`,
                backgroundColor: (theme) =>
                  theme.palette.mode === 'light'
                    ? 'rgba(37, 99, 235, 0.06)'
                    : 'rgba(96, 165, 250, 0.12)',
              }}
            >
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  Appearance
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.2 }}>
                  {colorMode === 'dark' ? 'Dark mode' : 'Light mode'}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <LightMode fontSize="small" color={colorMode === 'light' ? 'primary' : 'disabled'} />
                <Switch
                  size="small"
                  checked={colorMode === 'dark'}
                  onChange={onToggleColorMode}
                  inputProps={{ 'aria-label': 'Toggle dark mode' }}
                />
                <DarkMode fontSize="small" color={colorMode === 'dark' ? 'primary' : 'disabled'} />
              </Box>
            </Box>
            <Button
              variant="outlined"
              startIcon={<Settings />}
              fullWidth
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
              onClick={handleOpenSettingsClick}
            >
              Agent Settings
            </Button>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
              Manage personas, tools, and prompts.
            </Typography>
            {onSignOut ? (
              <Button
                variant="text"
                color="inherit"
                startIcon={<Logout />}
                fullWidth
                onClick={onSignOut}
                sx={{
                  borderRadius: 2,
                  justifyContent: 'flex-start',
                  textTransform: 'none',
                  fontWeight: 600,
                  px: 1,
                  color: (theme) => theme.palette.text.secondary,
                  '&:hover': {
                    backgroundColor: (theme) =>
                      theme.palette.mode === 'light'
                        ? 'rgba(15, 23, 42, 0.06)'
                        : 'rgba(148, 163, 184, 0.12)',
                  },
                }}
              >
                Logout
              </Button>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Drawer>
  );
};

export default CollapsibleDrawer;
