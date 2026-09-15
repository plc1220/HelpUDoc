import React, { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Pin as PushPin, Trash2 as Delete, Trash2 as DeleteOutline, GitCompare as Difference, LogOut as ExitToApp, ChevronUp as ExpandLess, ChevronDown as ExpandMore, Users as Groups, History, Lock, UsersRound as ManageAccounts, MoreHorizontal as MoreHoriz, Upload as Publish, Share2 as Share, Unlink as LinkOff, Link, ArchiveRestore as RestoreFromTrash, RefreshCw as Sync, LockOpen as Unpublished } from 'lucide-react';
import './WorkspaceNavigator.css';

import type { Workspace } from '../types';
import {
  DRAFT_REVIEW_CHANGES_ACTION_LABEL,
  DRAFT_SYNC_ACTION_LABEL,
  isDraftReviewChangesActionable,
  isDraftSyncActionable,
} from '../utils/workspaceDraftSync';
import {
  getPrivateWorkspaceStatusLabel,
  getSharedWorkspaceStatusDetails,
  getSharedWorkspacePublicationLabel,
} from '../utils/workspaceStatusLabels';
import {
  getSharedWorkspaceLifecycleActions,
  getWorkspaceLifecycleStatus,
  isOwnerOnlyUnsharedWorkspace,
  WORKSPACE_LIFECYCLE_ACTION_LABELS,
  type WorkspaceLifecycleAction,
} from '../utils/workspaceLifecycle';

interface WorkspaceListProps {
  flat?: boolean;
  pinnedIds?: string[];
  onTogglePin?: (workspace: Workspace) => void;
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onPublishWorkspace?: (workspace: Workspace) => void;
  onHistoryWorkspace?: (workspace: Workspace) => void;
  onWithdrawWorkspace?: (workspace: Workspace) => void;
  onManageTeamAccess?: (workspace: Workspace) => void;
  onSyncDraftWorkspace?: (workspace: Workspace) => void;
  onReviewDraftChanges?: (workspace: Workspace) => void;
  onLifecycleWorkspace?: (workspace: Workspace, action: WorkspaceLifecycleAction) => void;
  syncingDraftWorkspaceId?: string | null;
  lifecycleBusyWorkspaceId?: string | null;
}

const COLLAPSE_STORAGE_KEY = 'helpudoc.workspace-sections';

const WorkspaceList: React.FC<WorkspaceListProps> = ({
  flat = false,
  pinnedIds = [],
  onTogglePin,
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  onDeleteWorkspace,
  onPublishWorkspace,
  onHistoryWorkspace,
  onWithdrawWorkspace,
  onManageTeamAccess,
  onSyncDraftWorkspace,
  onReviewDraftChanges,
  onLifecycleWorkspace,
  syncingDraftWorkspaceId = null,
  lifecycleBusyWorkspaceId = null,
}) => {
  const privateWorkspaces = workspaces.filter((workspace) => (
    (workspace.visibility !== 'team' || isOwnerOnlyUnsharedWorkspace(workspace))
      && getWorkspaceLifecycleStatus(workspace) !== 'trashed'
  ));
  const sharedWorkspaces = workspaces.filter((workspace) => (
    workspace.visibility === 'team'
      && !isOwnerOnlyUnsharedWorkspace(workspace)
      && getWorkspaceLifecycleStatus(workspace) !== 'trashed'
  ));
  const restorableWorkspaces = onLifecycleWorkspace
    ? workspaces.filter((workspace) => (
      getWorkspaceLifecycleStatus(workspace) === 'trashed'
        && getSharedWorkspaceLifecycleActions(workspace).includes('restore')
    ))
    : [];
  const [expanded, setExpanded] = useState({ private: true, shared: true, trash: false });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (stored) setExpanded((current) => ({ ...current, ...JSON.parse(stored) }));
    } catch {
      // Keep both sections open when preferences are unavailable.
    }
  }, []);

  const setSectionExpanded = (section: 'private' | 'shared' | 'trash', value: boolean) => {
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
    const isSharedWorkspace = workspace.visibility === 'team';
    const isOwnerOnlyUnshared = isOwnerOnlyUnsharedWorkspace(workspace);
    const isOwner = workspace.role === 'owner';
    const lifecycleStatus = getWorkspaceLifecycleStatus(workspace);
    const isLifecycleBusy = lifecycleBusyWorkspaceId === workspace.id;
    const isSelected = selectedWorkspace?.id === workspace.id;
    const hasChangesToPublish = workspace.publicationStatus === 'changes_to_publish';
    const isWithdrawn = workspace.publicationStatus === 'withdrawn';
    const hasPublishedVersions = Number(workspace.publishedVersionCount || 0) > 0
      || workspace.currentPublishedVersionNumber != null;
    const canSyncDraft = isDraftSyncActionable(workspace) && Boolean(onSyncDraftWorkspace);
    const canReviewDraftChanges = isDraftReviewChangesActionable(workspace)
      && Boolean(onReviewDraftChanges);
    const isSyncingDraft = syncingDraftWorkspaceId === workspace.id;
    const lifecycleIcons: Record<WorkspaceLifecycleAction, React.ReactNode> = {
      unshare: <LinkOff size={16} />,
      reshare: <Share size={16} />,
      trash: <DeleteOutline size={16} />,
      restore: <RestoreFromTrash size={16} />,
      leave: <ExitToApp size={16} />,
      reconnect: <Link size={16} />,
    };
    const availableLifecycleActions = onLifecycleWorkspace
      ? getSharedWorkspaceLifecycleActions(workspace)
      : [];
    const canRestore = availableLifecycleActions.includes('restore');
    const lifecycleActions = onLifecycleWorkspace
      ? availableLifecycleActions.map((action) => ({
        label: WORKSPACE_LIFECYCLE_ACTION_LABELS[action],
        icon: lifecycleIcons[action],
        disabled: isLifecycleBusy,
        onClick: () => onLifecycleWorkspace(workspace, action),
      }))
      : [];
    const actions = [
      onTogglePin ? { label: pinnedIds.includes(workspace.id) ? "Unpin workspace" : "Pin workspace", icon: <PushPin size={16} />, onClick: () => onTogglePin(workspace) } : null,
      isPrivate
        && !isOwnerOnlyUnshared
        && lifecycleStatus === 'active'
        && workspace.publicationStatus === 'detached'
        && onLifecycleWorkspace ? {
          label: WORKSPACE_LIFECYCLE_ACTION_LABELS.reconnect,
          icon: lifecycleIcons.reconnect,
          disabled: isLifecycleBusy,
          onClick: () => onLifecycleWorkspace(workspace, 'reconnect'),
        } : null,
      canSyncDraft && onSyncDraftWorkspace ? {
        label: DRAFT_SYNC_ACTION_LABEL,
        icon: <Sync size={16} />,
        onClick: () => onSyncDraftWorkspace(workspace),
      } : null,
      canReviewDraftChanges && onReviewDraftChanges ? {
        label: DRAFT_REVIEW_CHANGES_ACTION_LABEL,
        icon: <Difference size={16} />,
        onClick: () => onReviewDraftChanges(workspace),
      } : null,
      isPrivate
        && workspace.publicationStatus !== 'detached'
        && !workspace.linkedTeamWorkspaceId
        && onPublishWorkspace ? {
        label: `Share workspace`,
        icon: <Share size={16} />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      isPrivate && workspace.linkedTeamWorkspaceId ? {
        label: `Open shared workspace`,
        icon: <Groups size={16} />,
        onClick: () => {
          const linked = workspaces.find((item) => item.id === workspace.linkedTeamWorkspaceId);
          if (linked) onSelectWorkspace(linked);
        },
      } : null,
      isSharedWorkspace && lifecycleStatus === 'active' && workspace.canPublish && (hasChangesToPublish || isWithdrawn) && onPublishWorkspace ? {
        label: 'Lock current changes',
        icon: <Publish size={16} />,
        onClick: () => onPublishWorkspace(workspace),
      } : null,
      isSharedWorkspace && lifecycleStatus !== 'trashed' && hasPublishedVersions && onHistoryWorkspace ? {
        label: `View locked versions`,
        icon: <History size={16} />,
        onClick: () => onHistoryWorkspace(workspace),
      } : null,
      isSharedWorkspace && lifecycleStatus === 'active' && workspace.canPublish && workspace.currentPublishedVersionNumber != null && onWithdrawWorkspace ? {
        label: `Withdraw current lock`,
        icon: <Unpublished size={16} />,
        onClick: () => onWithdrawWorkspace(workspace),
      } : null,
      isSharedWorkspace && lifecycleStatus === 'active' && isOwner && onManageTeamAccess ? {
        label: `Manage access`,
        icon: <ManageAccounts size={16} />,
        onClick: () => onManageTeamAccess(workspace),
      } : null,
      !isSharedWorkspace && !onLifecycleWorkspace ? {
        label: `Delete workspace`,
        icon: <Delete size={16} />,
        onClick: () => onDeleteWorkspace(workspace.id),
      } : null,
      ...lifecycleActions,
    ].filter(Boolean) as Array<{
      label: string;
      icon: React.ReactNode;
      onClick: () => void;
      disabled?: boolean;
    }>;
    const menuActions = lifecycleStatus === 'trashed' ? [] : actions;

    const publicationLabel = getSharedWorkspacePublicationLabel(workspace);
    const sharedDetails = getSharedWorkspaceStatusDetails(workspace);
    const draftStatusLabel = getPrivateWorkspaceStatusLabel(workspace);
    const ownerOnlyStatusLabel = 'Unshared · Only you can access it';
    const status = isOwnerOnlyUnshared ? ownerOnlyStatusLabel : isPrivate ? draftStatusLabel : sharedDetails;
    return <div key={workspace.id} className="workspace-row" data-selected={isSelected}>
      <button type="button" className="workspace-row-select" aria-current={isSelected ? 'page' : undefined} disabled={lifecycleStatus === 'trashed'} onClick={() => onSelectWorkspace(workspace)}>
        <span className="workspace-row-title">{workspace.name}</span>
        <span className="workspace-row-status">{!isPrivate && <span className="workspace-status-dot" aria-label={publicationLabel} />}{status}</span>
      </button>
      {canRestore && onLifecycleWorkspace && <Button label={isLifecycleBusy ? 'Restoring…' : 'Restore'} aria-label={`Restore ${workspace.name}`} size="sm" variant="ghost" isDisabled={isLifecycleBusy} onClick={() => onLifecycleWorkspace(workspace, 'restore')} />}
      {!!menuActions.length && <div className="workspace-list-more"><DropdownMenu hasChevron={false} button={{ label: `More actions for ${workspace.name}`, icon: <MoreHoriz size={17} />, isIconOnly: true, variant: 'ghost', size: 'sm' }} menuWidth={230} items={menuActions.map((action) => ({ label: action.label, icon: action.icon, isDisabled: action.disabled, onClick: action.onClick }))} /></div>}
      {isPrivate && canSyncDraft && onSyncDraftWorkspace && <div className="workspace-inline-action"><Button label={isSyncingDraft ? 'Syncing…' : DRAFT_SYNC_ACTION_LABEL} aria-label={`${DRAFT_SYNC_ACTION_LABEL} for ${workspace.name}`} icon={<Sync size={14} />} size="sm" variant="ghost" isDisabled={isSyncingDraft} onClick={() => onSyncDraftWorkspace(workspace)} /></div>}
    </div>;
  };

  const renderSection = (key: 'private' | 'shared' | 'trash', title: string, icon: React.ReactNode, items: Workspace[], emptyLabel: string) => <section>
    <button type="button" className="workspace-section-toggle" aria-expanded={expanded[key]} onClick={() => setSectionExpanded(key, !expanded[key])}>
      {icon}<span>{title}</span><span>{items.length}</span>{expanded[key] ? <ExpandLess size={14} /> : <ExpandMore size={14} />}
    </button>
    {expanded[key] && (items.length ? items.map(renderWorkspace) : <p className="workspace-empty">{emptyLabel}</p>)}
  </section>;
  if (flat) return <div className="workspace-list">{workspaces.map(renderWorkspace)}</div>;
  return <div className="workspace-list">
    {renderSection('private', 'Private workspaces', <Lock size={16} />, privateWorkspaces, 'No private workspaces')}
    {renderSection('shared', 'Shared workspaces', <Groups size={16} />, sharedWorkspaces, 'No shared workspaces')}
    {!!restorableWorkspaces.length && renderSection('trash', 'Trash', <DeleteOutline size={16} />, restorableWorkspaces, 'Trash is empty')}
  </div>;
};
export default WorkspaceList;
