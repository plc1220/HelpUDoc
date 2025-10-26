import React from 'react';
import { Box, IconButton } from '@mui/material';
import { Menu as MenuIcon } from '@mui/icons-material';

interface SidebarProps {
  handleDrawerToggle: () => void;
}

const ExpandableSidebar: React.FC<SidebarProps> = ({ handleDrawerToggle }) => {
  return (
    <Box
      sx={{
        width: 60,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        py: 2,
        bgcolor: 'background.paper',
        borderRight: '1px solid',
        borderColor: 'divider',
      }}
    >
      <IconButton onClick={handleDrawerToggle}>
        <MenuIcon />
      </IconButton>
    </Box>
  );
};

export default ExpandableSidebar;