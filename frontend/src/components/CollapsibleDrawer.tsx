import NotificationCenter from './NotificationCenter';
import React from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Plus, CalendarDays, ChevronLeft, Settings, Sun, Moon, LogOut, Search } from 'lucide-react';
import './WorkspaceNavigator.css';
import WorkspaceNavigator from './WorkspaceNavigator';
import type { Workspace } from '../types';
import type { PaletteMode } from '@mui/material';
import type { WorkspaceLifecycleAction } from '../utils/workspaceLifecycle';

interface CollapsibleDrawerProps {
  storageKey: string;
  onRefresh: () => Promise<unknown>;
  open: boolean;
  handleDrawerClose: () => void;
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  workspaceSearchQuery: string;
  setWorkspaceSearchQuery: (name: string) => void;
  handleDeleteWorkspace: (id: string) => void;
  onPublishWorkspace?: (workspace: Workspace) => void;
  onHistoryWorkspace?: (workspace: Workspace) => void;
  onWithdrawWorkspace?: (workspace: Workspace) => void;
  onManageTeamAccess?: (workspace: Workspace) => void;
  onSyncDraftWorkspace?: (workspace: Workspace) => void;
  onReviewDraftChanges?: (workspace: Workspace) => void;
  onLifecycleWorkspace?: (workspace: Workspace, action: WorkspaceLifecycleAction) => void;
  syncingDraftWorkspaceId?: string | null;
  lifecycleBusyWorkspaceId?: string | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onCreateWorkspace: () => void | Promise<void>;
  onOpenSchedules?: () => void;
  scheduleCount?: number;
  onOpenSettings: () => void;
  colorMode: PaletteMode;
  onToggleColorMode: () => void;
  onSignOut?: () => void;
}

const drawerWidth = 280;

const CollapsibleDrawer: React.FC<CollapsibleDrawerProps> = ({
  storageKey,
  onRefresh,
  open,
  handleDrawerClose,
  workspaces,
  selectedWorkspace,
  workspaceSearchQuery,
  setWorkspaceSearchQuery,
  handleDeleteWorkspace,
  onPublishWorkspace,
  onHistoryWorkspace,
  onWithdrawWorkspace,
  onManageTeamAccess,
  onSyncDraftWorkspace,
  onReviewDraftChanges,
  onLifecycleWorkspace,
  syncingDraftWorkspaceId = null,
  lifecycleBusyWorkspaceId = null,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenSchedules,
  scheduleCount = 0,
  onOpenSettings,
  colorMode,
  onToggleColorMode,
  onSignOut,
}) => {
  const handleOpenSettingsClick = () => {
    handleDrawerClose();
    onOpenSettings();
  };

  return <div style={{ width: drawerWidth, flexShrink: 0 }}>
    <aside className="workspace-pane" aria-label="Workspaces" inert={!open} style={{ transform: open ? 'none' : 'translateX(-100%)' }}>
      <header className="workspace-pane-toolbar">
        <div className="workspace-pane-actions">
          <IconButton label="Create workspace" tooltip="New workspace" icon={<Plus size={19} />} variant="ghost" onClick={() => void onCreateWorkspace()} />
          {onOpenSchedules && <IconButton label={scheduleCount ? `Open schedules, ${scheduleCount} scheduled jobs` : 'Open schedules'} tooltip={scheduleCount ? `Schedules (${scheduleCount})` : 'Schedules'} icon={<CalendarDays size={18} />} variant="ghost" isDisabled={!selectedWorkspace || selectedWorkspace.visibility === 'team'} onClick={onOpenSchedules} />}
        </div>
        <IconButton label="Close workspace menu" icon={<ChevronLeft size={19} />} variant="ghost" onClick={handleDrawerClose} />
      </header>
      <TextInput label="Search workspaces" isLabelHidden placeholder="Search workspaces" startIcon={<Search size={16} />} value={workspaceSearchQuery} onChange={setWorkspaceSearchQuery} width="100%" />
      <div className="workspace-pane-scroll">
        <WorkspaceNavigator key={storageKey} storageKey={storageKey} search={workspaceSearchQuery} onRefresh={onRefresh}
          workspaces={workspaces} selectedWorkspace={selectedWorkspace} onSelectWorkspace={onSelectWorkspace} onDeleteWorkspace={handleDeleteWorkspace}
          onPublishWorkspace={onPublishWorkspace} onHistoryWorkspace={onHistoryWorkspace} onWithdrawWorkspace={onWithdrawWorkspace}
          onManageTeamAccess={onManageTeamAccess} onSyncDraftWorkspace={onSyncDraftWorkspace} onReviewDraftChanges={onReviewDraftChanges}
          onLifecycleWorkspace={onLifecycleWorkspace} syncingDraftWorkspaceId={syncingDraftWorkspaceId} lifecycleBusyWorkspaceId={lifecycleBusyWorkspaceId} />
      </div>
      <footer className="workspace-pane-toolbar workspace-pane-footer">
        <IconButton label={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} icon={colorMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />} variant="ghost" onClick={onToggleColorMode} />
        {open && <NotificationCenter />}
        <IconButton label="Agent settings" icon={<Settings size={18} />} variant="ghost" onClick={handleOpenSettingsClick} />
        {onSignOut && <IconButton label="Logout" icon={<LogOut size={18} />} variant="ghost" onClick={onSignOut} />}
      </footer>
    </aside>
  </div>;
};

export default CollapsibleDrawer;
