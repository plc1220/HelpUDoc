import React from 'react';
import {
  Box,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Menu,
  MenuItem,
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
  MoreHoriz,
  Publish,
  Share,
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
  const [actionAnchorEl, setActionAnchorEl] = React.useState<null | HTMLElement>(null);
  const [actionWorkspaceId, setActionWorkspaceId] = React.useState<string | null>(null);

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
        label: status === 'private_draft'
          ? `Share or publish ${workspace.name}`
          : workspace.currentPublishedVersionNumber == null
            ? `Publish the first version of ${workspace.name}`
            : `Publish changes from ${workspace.name}`,
        icon: status === 'private_draft' ? <Share fontSize="small" /> : <Publish fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      canSync && onSyncWorkspace ? {
        label: status === 'review_needed'
          ? `Review changes for ${workspace.name}`
          : `Sync team updates into ${workspace.name}`,
        icon: <Sync fontSize="small" />,
        onClick: () => onSyncWorkspace(workspace),
      } : null,
      !isPrivate
      && onWorkPrivately
      && (workspace.role === 'owner' || workspace.role === 'editor' || workspace.role === 'contributor') ? {
        label: workspace.privateCopyWorkspaceId
          ? `Open private copy of ${workspace.name}`
          : `Work privately on ${workspace.name}`,
        icon: <ContentCopy fontSize="small" />,
        onClick: () => onWorkPrivately(workspace),
      } : null,
      !isPrivate && onHistoryWorkspace ? {
        label: `Open published history for ${workspace.name}`,
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

    const isActionMenuOpen = actionWorkspaceId === workspace.id;
    const sharedWorkspaceSubtitle = workspace.currentPublishedVersionNumber == null
      ? `${workspace.teamName || (workspace.audienceType === 'selected_people' ? 'Selected people' : 'Shared')} · Not published`
      : `${workspace.teamName || (workspace.audienceType === 'selected_people' ? 'Selected people' : 'Shared')} · Published v${workspace.currentPublishedVersionNumber}`;

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
          '&:hover .workspace-list-more, &:focus-within .workspace-list-more': {
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
            pr: actions.length ? 6 : 1.5,
            borderRadius: 2,
            backgroundColor: 'transparent',
            '&.Mui-selected, &.Mui-selected:hover, &:hover': { backgroundColor: 'transparent' },
          }}
        >
          <ListItemText
            sx={{ minWidth: 0 }}
            primary={workspace.name}
            secondary={
              isPrivate
                ? STATUS_LABELS[status]
                : sharedWorkspaceSubtitle
            }
            primaryTypographyProps={{
              sx: {
                display: '-webkit-box',
                overflow: 'hidden',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflowWrap: 'anywhere',
                fontWeight: 600,
                fontSize: '0.92rem',
                lineHeight: 1.2,
                mb: 0.25,
              },
            }}
            secondaryTypographyProps={{
              sx: {
                display: '-webkit-box',
                overflow: 'hidden',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflowWrap: 'anywhere',
                fontSize: '0.76rem',
                lineHeight: 1.25,
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
            className="workspace-list-more"
            sx={{
              position: 'absolute',
              top: '50%',
              right: 6,
              transform: 'translateY(-50%)',
              opacity: 0,
              pointerEvents: 'none',
            }}
          >
            <Tooltip title="More workspace actions">
              <IconButton
                size="small"
                aria-label={`More actions for ${workspace.name}`}
                aria-haspopup="menu"
                aria-expanded={isActionMenuOpen ? 'true' : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setActionAnchorEl(event.currentTarget);
                  setActionWorkspaceId(workspace.id);
                }}
                sx={{
                  width: 32,
                  height: 32,
                  backgroundColor: (theme) => theme.palette.mode === 'light'
                    ? 'rgba(248, 250, 252, 0.94)'
                    : 'rgba(15, 23, 42, 0.94)',
                  '&:hover': {
                    backgroundColor: (theme) => theme.palette.mode === 'light'
                      ? 'rgba(241, 245, 249, 1)'
                      : 'rgba(30, 41, 59, 1)',
                  },
                }}
              >
                <MoreHoriz fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        ) : null}
        <Menu
          anchorEl={actionAnchorEl}
          open={isActionMenuOpen}
          onClose={() => {
            setActionAnchorEl(null);
            setActionWorkspaceId(null);
          }}
          onClick={(event) => event.stopPropagation()}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{ paper: { sx: { minWidth: 220 } } }}
        >
          {actions.map((action) => (
            <MenuItem
              key={action.label}
              onClick={() => {
                setActionAnchorEl(null);
                setActionWorkspaceId(null);
                action.onClick();
              }}
              sx={{ gap: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>{action.icon}</ListItemIcon>
              <Typography variant="body2">{action.label}</Typography>
            </MenuItem>
          ))}
        </Menu>
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
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, px: 0.5, mb: 0.75, minWidth: 0 }}>
        {icon}
        <Typography
          variant="overline"
          sx={{
            minWidth: 0,
            flex: 1,
            fontWeight: 700,
            lineHeight: 1.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
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
      {renderSection('Shared workspaces', <Groups sx={{ fontSize: 16 }} />, teamWorkspaces, 'No shared workspaces')}
    </List>
  );
};

export default WorkspaceList;
