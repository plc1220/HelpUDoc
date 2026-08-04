import React, { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Delete,
  ExpandLess,
  ExpandMore,
  Groups,
  History,
  Lock,
  ManageAccounts,
  Publish,
  Share,
} from '@mui/icons-material';

import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onPublishWorkspace?: (workspace: Workspace) => void;
  onHistoryWorkspace?: (workspace: Workspace) => void;
  onManageTeamAccess?: (workspace: Workspace) => void;
}

const COLLAPSE_STORAGE_KEY = 'helpudoc.workspace-sections';

const WorkspaceList: React.FC<WorkspaceListProps> = ({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onDeleteWorkspace,
  onPublishWorkspace,
  onHistoryWorkspace,
  onManageTeamAccess,
}) => {
  const privateWorkspaces = workspaces.filter((workspace) => workspace.visibility !== 'team');
  const sharedWorkspaces = workspaces.filter((workspace) => workspace.visibility === 'team');
  const [expanded, setExpanded] = useState({ private: true, shared: true });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (stored) setExpanded((current) => ({ ...current, ...JSON.parse(stored) }));
    } catch {
      // Keep both sections open when preferences are unavailable.
    }
  }, []);

  const setSectionExpanded = (section: 'private' | 'shared', value: boolean) => {
    setExpanded((current) => {
      const next = { ...current, [section]: value };
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Preference persistence is best effort.
      }
      return next;
    });
  };

  const renderWorkspace = (workspace: Workspace) => {
    const isPrivate = workspace.visibility !== 'team';
    const isOwner = workspace.role === 'owner';
    const isSelected = selectedWorkspace?.id === workspace.id;
    const hasChangesToPublish = workspace.publicationStatus === 'changes_to_publish';

    const actions = [
      isPrivate && !workspace.linkedTeamWorkspaceId && onPublishWorkspace ? {
        label: `Share ${workspace.name}`,
        icon: <Share fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      isPrivate && workspace.linkedTeamWorkspaceId ? {
        label: `Open Shared workspace for ${workspace.name}`,
        icon: <Groups fontSize="small" />,
        onClick: () => {
          const linked = workspaces.find((item) => item.id === workspace.linkedTeamWorkspaceId);
          if (linked) onSelectWorkspace(linked);
        },
      } : null,
      !isPrivate && workspace.canPublish && hasChangesToPublish && onPublishWorkspace ? {
        label: workspace.currentPublishedVersionNumber == null
          ? `Create the first published version of ${workspace.name}`
          : `Publish changes from ${workspace.name}`,
        icon: <Publish fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      !isPrivate && workspace.currentPublishedVersionNumber != null && onHistoryWorkspace ? {
        label: `View published versions of ${workspace.name}`,
        icon: <History fontSize="small" />,
        onClick: () => onHistoryWorkspace(workspace),
      } : null,
      !isPrivate && isOwner && onManageTeamAccess ? {
        label: `Manage access for ${workspace.name}`,
        icon: <ManageAccounts fontSize="small" />,
        onClick: () => onManageTeamAccess(workspace),
      } : null,
      (isPrivate || isOwner) ? {
        label: `Delete ${workspace.name}`,
        icon: <Delete fontSize="small" />,
        onClick: () => onDeleteWorkspace(workspace.id),
      } : null,
    ].filter(Boolean) as Array<{ label: string; icon: React.ReactNode; onClick: () => void }>;

    const sharedDetails = [
      workspace.editingPolicy === 'review' ? 'Review' : 'Freeflow',
      workspace.currentPublishedVersionNumber == null
        ? 'Working version only'
        : `Published v${workspace.currentPublishedVersionNumber}`,
    ].join(' · ');

    return (
      <Box
        key={workspace.id}
        sx={{
          position: 'relative',
          borderRadius: 2,
          overflow: 'hidden',
          mb: 1,
          border: (theme) => isSelected ? `1px solid ${theme.palette.divider}` : '1px solid transparent',
          backgroundColor: (theme) => isSelected
            ? theme.palette.mode === 'light' ? 'rgba(37, 99, 235, 0.09)' : 'rgba(96, 165, 250, 0.14)'
            : 'transparent',
          '&:hover': {
            borderColor: (theme) => theme.palette.divider,
            backgroundColor: (theme) => isSelected
              ? undefined
              : theme.palette.mode === 'light' ? 'rgba(15, 23, 42, 0.04)' : 'rgba(148, 163, 184, 0.08)',
          },
          '&:hover .workspace-list-actions, &:focus-within .workspace-list-actions': {
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
            minHeight: 68,
            py: 1,
            pl: 1.5,
            pr: actions.length ? Math.min(12, 2.5 + actions.length * 3.5) : 1.5,
            borderRadius: 2,
            backgroundColor: 'transparent',
            '&.Mui-selected, &.Mui-selected:hover, &:hover': { backgroundColor: 'transparent' },
          }}
        >
          <ListItemText
            primary={workspace.name}
            secondary={isPrivate
              ? workspace.linkedTeamWorkspaceId ? 'Private copy' : 'Private'
              : sharedDetails}
            primaryTypographyProps={{
              noWrap: true,
              sx: { fontWeight: 600, fontSize: '0.92rem', lineHeight: 1.3, mb: 0.2 },
            }}
            secondaryTypographyProps={{
              noWrap: true,
              sx: {
                fontSize: '0.76rem',
                lineHeight: 1.3,
                color: hasChangesToPublish ? 'primary.main' : 'text.secondary',
              },
            }}
          />
        </ListItemButton>
        {actions.length ? (
          <Box
            className="workspace-list-actions"
            sx={{
              position: 'absolute',
              top: '50%',
              right: 6,
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 0.1,
              opacity: 0,
              pointerEvents: 'none',
              backgroundColor: (theme) => theme.palette.mode === 'light'
                ? 'rgba(248, 250, 252, 0.92)'
                : 'rgba(15, 23, 42, 0.9)',
              borderRadius: 1.5,
              px: 0.2,
              py: 0.2,
              backdropFilter: 'blur(6px)',
            }}
          >
            {actions.map((action) => (
              <Tooltip key={action.label} title={action.label}>
                <IconButton
                  size="small"
                  aria-label={action.label}
                  onClick={(event) => {
                    event.stopPropagation();
                    action.onClick();
                  }}
                  sx={{ width: 29, height: 29 }}
                >
                  {action.icon}
                </IconButton>
              </Tooltip>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  };

  const renderSection = (
    key: 'private' | 'shared',
    title: string,
    icon: React.ReactNode,
    items: Workspace[],
    emptyLabel: string,
  ) => (
    <Box sx={{ mb: 1.5 }}>
      <ListItemButton
        onClick={() => setSectionExpanded(key, !expanded[key])}
        aria-expanded={expanded[key]}
        sx={{ borderRadius: 1.5, px: 0.5, py: 0.5, mb: 0.5 }}
      >
        {icon}
        <Typography variant="overline" sx={{ ml: 0.75, fontWeight: 700, lineHeight: 1.5, flex: 1 }}>
          {title}
        </Typography>
        <Chip label={items.length} size="small" sx={{ height: 18, fontSize: '0.68rem', mr: 0.5 }} />
        {expanded[key] ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
      </ListItemButton>
      <Collapse in={expanded[key]} timeout="auto" unmountOnExit>
        {items.length ? items.map(renderWorkspace) : (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, py: 1 }}>
            {emptyLabel}
          </Typography>
        )}
      </Collapse>
    </Box>
  );

  return (
    <List disablePadding>
      {renderSection('private', 'Private workspaces', <Lock sx={{ fontSize: 16 }} />, privateWorkspaces, 'No private workspaces')}
      {renderSection('shared', 'Shared workspaces', <Groups sx={{ fontSize: 16 }} />, sharedWorkspaces, 'No shared workspaces')}
    </List>
  );
};

export default WorkspaceList;
