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
        // Its parent, not the viewport. This rail sits in the flex row below
        // `GovernmentStrip`, so that row is 34px shorter than the screen. At
        // `100vh` the rail overflowed by exactly the strip's height into a
        // parent that hides overflow, and `space-between` parks the Settings
        // button in precisely that clipped band — so the gear was cut in half
        // whenever the workspace panel was collapsed and the rail was showing.
        height: '100%',
      }}
    >
      {!isDrawerOpen && (
        <>
          <IconButton
            onClick={handleDrawerToggle}
            title="Open workspace menu"
            aria-label="Open workspace menu"
          >
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
