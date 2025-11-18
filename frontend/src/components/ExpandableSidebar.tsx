import React from 'react';
import { Box, IconButton } from '@mui/material';
import { Menu as MenuIcon } from '@mui/icons-material';

interface SidebarProps {
  handleDrawerToggle: () => void;
  isDrawerOpen: boolean;
}

const ExpandableSidebar: React.FC<SidebarProps> = ({ handleDrawerToggle, isDrawerOpen }) => {
  return (
    <Box
      sx={{
        width: isDrawerOpen ? 0 : 60,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        pt: isDrawerOpen ? 0 : 2,
        pb: isDrawerOpen ? 0 : 1,
        bgcolor: 'background.paper',
        borderRight: isDrawerOpen ? 'none' : '1px solid',
        borderColor: 'divider',
        transition: 'width 0.3s ease, padding 0.3s ease',
        overflow: 'hidden',
      }}
    >
      {!isDrawerOpen && (
        <IconButton onClick={handleDrawerToggle}>
          <MenuIcon />
        </IconButton>
      )}
    </Box>
  );
};

export default ExpandableSidebar;
