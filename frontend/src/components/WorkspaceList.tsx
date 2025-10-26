import React from 'react';
import { List, ListItem, ListItemText, IconButton, ListItemButton } from '@mui/material';
import { Delete } from '@mui/icons-material';

import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
}

const WorkspaceList: React.FC<WorkspaceListProps> = ({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onDeleteWorkspace,
}) => {
  return (
    <List>
      {workspaces.map((workspace) => (
        <ListItem
          key={workspace.id}
          disablePadding
          secondaryAction={
            <IconButton edge="end" aria-label="delete" onClick={() => onDeleteWorkspace(workspace.id)}>
              <Delete />
            </IconButton>
          }
        >
          <ListItemButton
            selected={selectedWorkspace?.id === workspace.id}
            onClick={() => onSelectWorkspace(workspace)}
          >
            <ListItemText primary={workspace.name} secondary={`Last used: ${workspace.lastUsed}`} />
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  );
};

export default WorkspaceList;