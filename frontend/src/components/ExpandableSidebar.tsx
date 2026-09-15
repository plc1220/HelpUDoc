import { IconButton } from '@astryxdesign/core/IconButton';
import { Menu, Settings } from 'lucide-react';
import NotificationCenter from './NotificationCenter';

interface SidebarProps {
  handleDrawerToggle: () => void;
  isDrawerOpen: boolean;
  onOpenSettings: () => void;
}

export default function ExpandableSidebar({ handleDrawerToggle, isDrawerOpen, onOpenSettings }: SidebarProps) {
  return <aside aria-label="Workspace controls" style={{
    width: isDrawerOpen ? 0 : 60,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBlock: isDrawerOpen ? 0 : 16,
    background: 'var(--color-background-surface)',
    borderRight: isDrawerOpen ? 'none' : '1px solid var(--color-border)',
    overflow: 'hidden',
    height: '100dvh',
  }}>
    {!isDrawerOpen && <>
      <IconButton label="Open workspace menu" icon={<Menu size={21} />} variant="ghost" onClick={handleDrawerToggle} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <NotificationCenter placement="end" />
        <IconButton label="Settings" tooltip="Settings" icon={<Settings size={20} strokeWidth={1.7} />} variant="ghost" onClick={onOpenSettings} />
      </div>
    </>}
  </aside>;
}
