import React, { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
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
  MoreHoriz,
  Publish,
  Share,
  Unpublished,
} from '@mui/icons-material';

import type { Workspace } from '../types';

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onPublishWorkspace?: (workspace: Workspace) => void;
  onHistoryWorkspace?: (workspace: Workspace) => void;
  onWithdrawWorkspace?: (workspace: Workspace) => void;
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
  onWithdrawWorkspace,
  onManageTeamAccess,
}) => {
  const privateWorkspaces = workspaces.filter((workspace) => workspace.visibility !== 'team');
  const sharedWorkspaces = workspaces.filter((workspace) => workspace.visibility === 'team');
  const [expanded, setExpanded] = useState({ private: true, shared: true });
  const [expandedSharedWorkspaces, setExpandedSharedWorkspaces] = useState<Record<string, boolean>>({});
  const [actionAnchorEl, setActionAnchorEl] = useState<null | HTMLElement>(null);
  const [actionWorkspaceId, setActionWorkspaceId] = useState<string | null>(null);

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
    const isWithdrawn = workspace.publicationStatus === 'withdrawn';
    const hasPublishedVersions = Number(workspace.publishedVersionCount || 0) > 0
      || workspace.currentPublishedVersionNumber != null;
    const isWorkspaceExpanded = Boolean(expandedSharedWorkspaces[workspace.id]);

    const actions = [
      isPrivate && !workspace.linkedTeamWorkspaceId && onPublishWorkspace ? {
        label: `Share ${workspace.name}`,
        icon: <Share fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      isPrivate && workspace.linkedTeamWorkspaceId ? {
        label: `Open shared workspace for ${workspace.name}`,
        icon: <Groups fontSize="small" />,
        onClick: () => {
          const linked = workspaces.find((item) => item.id === workspace.linkedTeamWorkspaceId);
          if (linked) onSelectWorkspace(linked);
        },
      } : null,
      !isPrivate && workspace.canPublish && (hasChangesToPublish || isWithdrawn) && onPublishWorkspace ? {
        label: workspace.currentPublishedVersionNumber == null
          ? hasPublishedVersions
            ? `Publish ${workspace.name} again`
            : `Create the first published version of ${workspace.name}`
          : `Publish changes from ${workspace.name}`,
        icon: <Publish fontSize="small" />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      !isPrivate && hasPublishedVersions && onHistoryWorkspace ? {
        label: `Open published history for ${workspace.name}`,
        icon: <History fontSize="small" />,
        onClick: () => onHistoryWorkspace(workspace),
      } : null,
      !isPrivate && workspace.canPublish && workspace.currentPublishedVersionNumber != null && onWithdrawWorkspace ? {
        label: `Withdraw publication of ${workspace.name}`,
        icon: <Unpublished fontSize="small" />,
        onClick: () => onWithdrawWorkspace(workspace),
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

    const publicationLabel = isWithdrawn
      ? 'Publication withdrawn'
      : workspace.currentPublishedVersionNumber == null
        ? 'Working version only'
        : hasChangesToPublish
          ? `Changes since v${workspace.currentPublishedVersionNumber}`
          : `Published v${workspace.currentPublishedVersionNumber}`;
    const sharedDetails = [workspace.editingPolicy === 'review' ? 'Review' : 'Freeflow', publicationLabel].join(' · ');
    const statusColor = isWithdrawn
      ? 'text.disabled'
      : workspace.currentPublishedVersionNumber == null
        ? 'text.secondary'
        : hasChangesToPublish
          ? 'warning.main'
          : 'success.main';
    const isActionMenuOpen = actionWorkspaceId === workspace.id;

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
          onClick={() => {
            onSelectWorkspace(workspace);
            if (!isPrivate) {
              setExpandedSharedWorkspaces((current) => ({ ...current, [workspace.id]: true }));
            }
          }}
          sx={{
            minWidth: 0,
            minHeight: 68,
            py: 1,
            pl: isPrivate ? 1.5 : 0.5,
            pr: actions.length ? 6 : 1.5,
            borderRadius: 2,
            backgroundColor: 'transparent',
            '&.Mui-selected, &.Mui-selected:hover, &:hover': { backgroundColor: 'transparent' },
          }}
        >
          {!isPrivate ? (
            <IconButton
              size="small"
              aria-label={`${isWorkspaceExpanded ? 'Collapse' : 'Expand'} ${workspace.name}`}
              aria-expanded={isWorkspaceExpanded}
              onClick={(event) => {
                event.stopPropagation();
                setExpandedSharedWorkspaces((current) => ({
                  ...current,
                  [workspace.id]: !current[workspace.id],
                }));
              }}
              sx={{ width: 28, height: 28, mr: 0.25, flexShrink: 0 }}
            >
              {isWorkspaceExpanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
            </IconButton>
          ) : null}
          <ListItemText
            sx={{ minWidth: 0 }}
            primary={workspace.name}
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
            secondaryTypographyProps={{ component: 'span' }}
            secondary={isPrivate ? (
              workspace.linkedTeamWorkspaceId ? 'Private copy' : 'Private'
            ) : (
              <Box component="span" sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.7, minWidth: 0 }}>
                <Box
                  component="span"
                  aria-label={publicationLabel}
                  sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: statusColor, flexShrink: 0, mt: '0.35em' }}
                />
                <Typography
                  component="span"
                  sx={{
                    display: '-webkit-box',
                    overflow: 'hidden',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2,
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                    fontSize: '0.76rem',
                    lineHeight: 1.25,
                    color: hasChangesToPublish || isWithdrawn ? statusColor : 'text.secondary',
                  }}
                >
                  {sharedDetails}
                </Typography>
              </Box>
            )}
          />
        </ListItemButton>
        {actions.length ? (
          <Box
            className="workspace-list-more"
            sx={{
              position: 'absolute',
              top: 34,
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
        {!isPrivate ? (
          <Collapse in={isWorkspaceExpanded} timeout="auto" unmountOnExit>
            <Box sx={{ pb: 0.75, pl: 4.25, pr: 1 }}>
              <Box sx={{ px: 1, py: 0.6 }}>
                <Typography variant="body2" sx={{ fontSize: '0.8rem', fontWeight: 500 }}>
                  Working version
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  The shared workspace you are viewing
                </Typography>
              </Box>
              {hasPublishedVersions ? (
                <ListItemButton
                  onClick={() => onHistoryWorkspace?.(workspace)}
                  sx={{ minHeight: 34, borderRadius: 1.5, px: 1, py: 0.35 }}
                >
                  <ListItemText
                    primary="Published history & restore"
                    secondary={workspace.currentPublishedVersionNumber == null
                      ? 'No current version'
                      : `v${workspace.currentPublishedVersionNumber} is current`}
                    primaryTypographyProps={{ sx: { fontSize: '0.8rem', fontWeight: 500 } }}
                    secondaryTypographyProps={{ sx: { fontSize: '0.7rem' } }}
                  />
                </ListItemButton>
              ) : null}
            </Box>
          </Collapse>
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
        sx={{ borderRadius: 1.5, px: 0.5, py: 0.5, mb: 0.5, minWidth: 0 }}
      >
        {icon}
        <Typography
          variant="overline"
          sx={{
            minWidth: 0,
            ml: 0.75,
            flex: 1,
            fontWeight: 700,
            lineHeight: 1.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
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
