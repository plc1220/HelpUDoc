import React from 'react';
import {
  Box,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ContentCopy,
  Delete,
  Groups,
  History,
  Lock,
  ManageAccounts,
  Publish,
  Sync,
} from '@mui/icons-material';

import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onPublishWorkspace?: (workspace: Workspace) => void;
  onSyncWorkspace?: (workspace: Workspace) => void;
  onWorkPrivately?: (workspace: Workspace) => void;
  onHistoryWorkspace?: (workspace: Workspace) => void;
  onManageTeamAccess?: (workspace: Workspace) => void;
}

const STATUS_LABELS: Record<NonNullable<Workspace['publicationStatus']>, string> = {
  private_draft: 'Private draft',
  up_to_date: 'Up to date',
  changes_to_publish: 'Changes to publish',
  team_updates_available: 'Team updates available',
  review_needed: 'Review needed',
};

const WorkspaceList: React.FC<WorkspaceListProps> = ({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onDeleteWorkspace,
  onPublishWorkspace,
  onSyncWorkspace,
  onWorkPrivately,
  onHistoryWorkspace,
  onManageTeamAccess,
}) => {
  const privateWorkspaces = workspaces.filter((workspace) => workspace.visibility !== 'team');
  const teamWorkspaces = workspaces.filter((workspace) => workspace.visibility === 'team');

  const renderWorkspace = (workspace: Workspace) => {
    const isPrivate = workspace.visibility !== 'team';
    const isOwner = workspace.role === 'owner';
    const isSelected = selectedWorkspace?.id === workspace.id;
    const status = workspace.publicationStatus || (isPrivate ? 'private_draft' : 'up_to_date');
    const canPublish = isPrivate
      && workspace.canPublish !== false
      && (status === 'private_draft' || status === 'changes_to_publish');
    const canSync = isPrivate
      && (status === 'team_updates_available' || status === 'review_needed');

    const actions = [
      canPublish && onPublishWorkspace ? {
        label: status === 'private_draft' ? `Publish ${workspace.name} to team` : `Publish changes from ${workspace.name}`,
        icon: <Publish fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      canSync && onSyncWorkspace ? {
        label: status === 'review_needed'
          ? `Review changes for ${workspace.name}`
          : `Sync team updates into ${workspace.name}`,
        icon: <Sync fontSize="small" />,
        onClick: () => onSyncWorkspace(workspace),
      } : null,
      !isPrivate && onWorkPrivately ? {
        label: workspace.privateCopyWorkspaceId
          ? `Open private copy of ${workspace.name}`
          : `Work privately on ${workspace.name}`,
        icon: <ContentCopy fontSize="small" />,
        onClick: () => onWorkPrivately(workspace),
      } : null,
      !isPrivate && onHistoryWorkspace ? {
        label: `View published history for ${workspace.name}`,
        icon: <History fontSize="small" />,
        onClick: () => onHistoryWorkspace(workspace),
      } : null,
      !isPrivate && isOwner && onManageTeamAccess ? {
        label: `Manage publishing access for ${workspace.name}`,
        icon: <ManageAccounts fontSize="small" />,
        onClick: () => onManageTeamAccess(workspace),
      } : null,
      (isPrivate || isOwner) ? {
        label: `Delete ${workspace.name}`,
        icon: <Delete fontSize="small" />,
        onClick: () => onDeleteWorkspace(workspace.id),
      } : null,
    ].filter(Boolean) as Array<{ label: string; icon: React.ReactNode; onClick: () => void }>;

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
            secondary={
              isPrivate
                ? STATUS_LABELS[status]
                : `${workspace.teamName || 'Team'}${workspace.latestPublisherName
                  ? ` · ${workspace.latestPublisherName}`
                  : ''}`
            }
            primaryTypographyProps={{
              noWrap: true,
              sx: { fontWeight: 600, fontSize: '0.92rem', lineHeight: 1.3, mb: 0.2 },
            }}
            secondaryTypographyProps={{
              noWrap: true,
              sx: {
                fontSize: '0.76rem',
                lineHeight: 1.3,
                color: status === 'review_needed'
                  ? 'warning.main'
                  : status === 'changes_to_publish' || status === 'team_updates_available'
                    ? 'primary.main'
                    : 'text.secondary',
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
    title: string,
    icon: React.ReactNode,
    items: Workspace[],
    emptyLabel: string,
  ) => (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 0.5, mb: 0.75 }}>
        {icon}
        <Typography variant="overline" sx={{ fontWeight: 700, lineHeight: 1.5 }}>
          {title}
        </Typography>
        <Chip label={items.length} size="small" sx={{ height: 18, fontSize: '0.68rem' }} />
      </Box>
      {items.length ? items.map(renderWorkspace) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, py: 1 }}>
          {emptyLabel}
        </Typography>
      )}
    </Box>
  );

  return (
    <List disablePadding>
      {renderSection('Private workspaces', <Lock sx={{ fontSize: 16 }} />, privateWorkspaces, 'No private workspaces')}
      {renderSection('Team workspaces', <Groups sx={{ fontSize: 16 }} />, teamWorkspaces, 'No team workspaces')}
    </List>
  );
};

export default WorkspaceList;
