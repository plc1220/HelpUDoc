import React from 'react';
import { Box, IconButton } from '@mui/material';
import { Menu as MenuIcon } from '@mui/icons-material';

import { Settings as SettingsIcon } from '@mui/icons-material';

interface SidebarProps {
  handleDrawerToggle: () => void;
  isDrawerOpen: boolean;
  onOpenSettings: () => void;
}

const ExpandableSidebar: React.FC<SidebarProps> = ({ handleDrawerToggle, isDrawerOpen, onOpenSettings }) => {
  return (
    <Box
      sx={{
        width: isDrawerOpen ? 0 : 60,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        pt: isDrawerOpen ? 0 : 2,
        pb: isDrawerOpen ? 0 : 2,
        bgcolor: 'background.paper',
        borderRight: isDrawerOpen ? 'none' : '1px solid',
        borderColor: 'divider',
        transition: 'width 0.3s ease, padding 0.3s ease',
        overflow: 'hidden',
        height: '100vh',
      }}
    >
      {!isDrawerOpen && (
        <>
          <IconButton onClick={handleDrawerToggle}>
            <MenuIcon />
          </IconButton>
          <IconButton onClick={onOpenSettings} title="Settings">
            <SettingsIcon />
          </IconButton>
        </>
      )}
    </Box>
  );
};

export default ExpandableSidebar;
