import React from 'react';
import { Box, IconButton, List, ListItemButton, ListItemText } from '@mui/material';
import { Delete, Share } from '@mui/icons-material';

import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onShareWorkspace?: (workspace: Workspace) => void;
}

const WorkspaceList: React.FC<WorkspaceListProps> = ({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onDeleteWorkspace,
  onShareWorkspace,
}) => {
  return (
    <List disablePadding>
      {workspaces.map((workspace) => {
        const isOwner = workspace.role === 'owner';
        const isSelected = selectedWorkspace?.id === workspace.id;

        return (
          <Box
            key={workspace.id}
            sx={{
              position: 'relative',
              borderRadius: 2,
              overflow: 'hidden',
              mb: 1,
              border: (theme) =>
                isSelected ? `1px solid ${theme.palette.divider}` : '1px solid transparent',
              backgroundColor: (theme) => {
                if (isSelected) {
                  return theme.palette.mode === 'light'
                    ? 'rgba(37, 99, 235, 0.09)'
                    : 'rgba(96, 165, 250, 0.14)';
                }
                return 'transparent';
              },
              transition: (theme) =>
                theme.transitions.create(['background-color', 'border-color'], {
                  duration: theme.transitions.duration.shorter,
                }),
              '&:hover': {
                borderColor: (theme) => theme.palette.divider,
                backgroundColor: (theme) =>
                  isSelected
                    ? undefined
                    : theme.palette.mode === 'light'
                      ? 'rgba(15, 23, 42, 0.04)'
                      : 'rgba(148, 163, 184, 0.08)',
              },
              '&:hover .workspace-list-actions': {
                opacity: 1,
                pointerEvents: 'auto',
              },
              '&:focus-within .workspace-list-actions': {
                opacity: 1,
                pointerEvents: 'auto',
              },
            }}
          >
            <ListItemButton
              selected={isSelected}
              onClick={() => onSelectWorkspace(workspace)}
              sx={{
                minWidth: 0,
                minHeight: 64,
                py: 1.25,
                pl: 1.75,
                pr: isOwner ? 8.5 : 1.75,
                borderRadius: 2,
                backgroundColor: 'transparent',
                '&.Mui-selected': {
                  backgroundColor: 'transparent',
                },
                '&.Mui-selected:hover': {
                  backgroundColor: 'transparent',
                },
                '&:hover': {
                  backgroundColor: 'transparent',
                },
              }}
            >
              <ListItemText
                primary={workspace.name}
                secondary={`Last used: ${workspace.lastUsed}`}
                primaryTypographyProps={{
                  noWrap: true,
                  sx: { fontWeight: 600, fontSize: '0.95rem', lineHeight: 1.35, mb: 0.25 },
                }}
                secondaryTypographyProps={{
                  noWrap: true,
                  sx: { fontSize: '0.82rem', lineHeight: 1.35 },
                }}
              />
            </ListItemButton>
            {isOwner ? (
              <Box
                className="workspace-list-actions"
                sx={{
                  position: 'absolute',
                  top: '50%',
                  right: 8,
                  transform: 'translateY(-50%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  opacity: 0,
                  pointerEvents: 'none',
                  transition: (theme) =>
                    theme.transitions.create('opacity', { duration: theme.transitions.duration.shorter }),
                  backgroundColor: (theme) =>
                    theme.palette.mode === 'light'
                      ? 'rgba(248, 250, 252, 0.86)'
                      : 'rgba(15, 23, 42, 0.84)',
                  borderRadius: 1.5,
                  px: 0.25,
                  py: 0.25,
                  backdropFilter: 'blur(6px)',
                }}
              >
                {onShareWorkspace ? (
                  <IconButton
                    size="small"
                    aria-label={`Share ${workspace.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onShareWorkspace(workspace);
                    }}
                    sx={{ width: 30, height: 30 }}
                  >
                    <Share fontSize="small" />
                  </IconButton>
                ) : null}
                <IconButton
                  size="small"
                  aria-label={`Delete ${workspace.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteWorkspace(workspace.id);
                  }}
                  sx={{ width: 30, height: 30 }}
                >
                  <Delete fontSize="small" />
                </IconButton>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </List>
  );
};

export default WorkspaceList;
