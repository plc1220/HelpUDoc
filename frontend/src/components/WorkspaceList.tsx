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
        label: `Open Shared workspace for ${workspace.name}`,
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
        label: `View published versions of ${workspace.name}`,
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
            pr: actions.length ? Math.min(12, 2.5 + actions.length * 3.5) : 1.5,
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
            primary={workspace.name}
            primaryTypographyProps={{
              noWrap: true,
              sx: { fontWeight: 600, fontSize: '0.92rem', lineHeight: 1.3, mb: 0.2 },
            }}
            secondaryTypographyProps={{ component: 'span' }}
            secondary={isPrivate ? (
              workspace.linkedTeamWorkspaceId ? 'Private copy' : 'Private'
            ) : (
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.7, minWidth: 0 }}>
                <Box
                  component="span"
                  aria-label={publicationLabel}
                  sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: statusColor, flexShrink: 0 }}
                />
                <Typography
                  component="span"
                  noWrap
                  sx={{
                    fontSize: '0.76rem',
                    lineHeight: 1.3,
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
            className="workspace-list-actions"
            sx={{
              position: 'absolute',
              top: 34,
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
        {!isPrivate ? (
          <Collapse in={isWorkspaceExpanded} timeout="auto" unmountOnExit>
            <Box sx={{ pb: 0.75, pl: 4.25, pr: 1 }}>
              <ListItemButton
                selected={isSelected}
                onClick={() => onSelectWorkspace(workspace)}
                sx={{ minHeight: 34, borderRadius: 1.5, px: 1, py: 0.35 }}
              >
                <ListItemText
                  primary="Working version"
                  primaryTypographyProps={{ sx: { fontSize: '0.8rem', fontWeight: 500 } }}
                />
              </ListItemButton>
              {hasPublishedVersions && onHistoryWorkspace ? (
                <ListItemButton
                  onClick={() => onHistoryWorkspace(workspace)}
                  sx={{ minHeight: 34, borderRadius: 1.5, px: 1, py: 0.35 }}
                >
                  <ListItemText
                    primary={`Published versions (${workspace.publishedVersionCount
                      ?? (workspace.currentPublishedVersionNumber == null ? 0 : 1)})`}
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
