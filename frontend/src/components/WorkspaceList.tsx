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

        return (
          <Box
            key={workspace.id}
            sx={{
              display: 'flex',
              alignItems: 'stretch',
              borderRadius: 1,
              '&:hover .workspace-list-actions': {
                opacity: 1,
                pointerEvents: 'auto',
              },
            }}
          >
            <ListItemButton
              selected={selectedWorkspace?.id === workspace.id}
              onClick={() => onSelectWorkspace(workspace)}
              sx={{ flex: '1 1 auto', minWidth: 0, py: 1.25, pr: 1 }}
            >
              <ListItemText primary={workspace.name} secondary={`Last used: ${workspace.lastUsed}`} />
            </ListItemButton>
            {isOwner ? (
              <Box
                className="workspace-list-actions"
                sx={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.25,
                  pr: 0.5,
                  pl: 0.25,
                  opacity: 0,
                  pointerEvents: 'none',
                  transition: (theme) =>
                    theme.transitions.create('opacity', { duration: theme.transitions.duration.shorter }),
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
