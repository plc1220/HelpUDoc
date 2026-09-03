import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PackageOpen,
  BookOpen,
  CreditCard,
  FolderOpen,
  MessageCircle,
  ArrowLeftCircle,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import { fetchCapabilities } from '../../../services/activityApi';

type NavItem = {
  label: string;
  path: string;
  icon: ComponentType<{ size?: number }>;
  /** Shown only when the server says this caller can reach it. */
  requiresActivityAccess?: boolean;
};

type SettingsShellProps = {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
};

const BASE_NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/settings' },
  { label: 'Activity', icon: Activity, path: '/settings/activity', requiresActivityAccess: true },
  { label: 'Skill Governance', icon: ShieldCheck, path: '/skills' },
  { label: 'Plugins & integrations', icon: PackageOpen, path: '/settings/agents' },
  { label: 'Knowledge', icon: BookOpen, path: '/settings/knowledge' },
  { label: 'Users', icon: MessageCircle, path: '/settings/users' },
  { label: 'Workspaces', icon: FolderOpen, path: '/settings/workspaces' },
  { label: 'Billing', icon: CreditCard, path: '/settings/billing' },
];

const SETTINGS_NAV_COLLAPSED_KEY = 'helpudoc-settings-nav-collapsed';

const getInitialNavigationState = () => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(SETTINGS_NAV_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
};

const SettingsShell = ({ title, description, eyebrow = 'Workspace settings', actions, children }: SettingsShellProps) => {
  const location = useLocation();
  const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(getInitialNavigationState);

  const [canViewActivity, setCanViewActivity] = useState(false);

  // Hiding the link is a courtesy, not a control: `/api/activity` enforces its
  // own access, and a member who navigates to the page directly still gets a
  // clear message rather than data.
  useEffect(() => {
    let cancelled = false;
    void fetchCapabilities()
      .then((capabilities) => {
        if (!cancelled) setCanViewActivity(capabilities.canViewActivity);
      })
      .catch(() => {
        if (!cancelled) setCanViewActivity(false);
      });
    return () => { cancelled = true; };
  }, []);

  const navItems = useMemo(
    () => BASE_NAV_ITEMS.filter((item) => !item.requiresActivityAccess || canViewActivity),
    [canViewActivity],
  );
  const toggleNavigation = () => {
    setIsNavigationCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SETTINGS_NAV_COLLAPSED_KEY, String(next));
      } catch {
        // The control remains usable when storage is unavailable.
      }
      return next;
    });
  };
  const backToWorkspaceAction = (
    <Button
      label="Back to Workspace"
      variant="secondary"
      size="sm"
      icon={<ArrowLeftCircle size={16} />}
      href="/"
    />
  );

  return (
    <div className="settings-portal">
      <aside
        className={`settings-portal-sidebar${isNavigationCollapsed ? ' settings-portal-sidebar-collapsed' : ''}`}
      >
        <div
          className={`settings-portal-sidebar-header${isNavigationCollapsed ? ' settings-portal-sidebar-header-collapsed' : ''}`}
        >
          <span className="settings-portal-sidebar-title">Settings</span>
          <IconButton
            label={isNavigationCollapsed ? 'Expand settings navigation' : 'Collapse settings navigation'}
            variant="ghost"
            size="sm"
            icon={isNavigationCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            onClick={toggleNavigation}
            className="settings-portal-nav-toggle"
            tooltip={isNavigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          />
        </div>
        <nav className="settings-portal-nav" aria-label="Settings navigation">
          <div className="settings-portal-nav-list">
            {navItems.map(({ label, icon: Icon, path }) => {
              const isActive = path === '/settings'
                ? location.pathname === path
                : location.pathname.startsWith(path);

              return (
                <Link
                  key={label}
                  to={path}
                  aria-current={isActive ? 'page' : undefined}
                  title={isNavigationCollapsed ? label : undefined}
                  className={`settings-portal-nav-item${isNavigationCollapsed ? ' settings-portal-nav-item-collapsed' : ''}${isActive ? ' settings-portal-nav-item-active' : ''}`}
                >
                  <Icon size={16} />
                  <span className="settings-portal-nav-label">{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </aside>

      <main className="settings-portal-main">
        <div className="settings-portal-content">
          <div className="settings-portal-page-stack">
            <div className="settings-portal-page-header">
              <div className="settings-portal-page-header-content">
                <div>
                  <p className="settings-portal-eyebrow">{eyebrow}</p>
                  <h2 className="settings-portal-page-title">{title}</h2>
                  {description && <p className="settings-portal-page-description">{description}</p>}
                </div>
                <div className="settings-portal-page-actions">
                  {backToWorkspaceAction}
                  {actions}
                </div>
              </div>
            </div>

            {children}
          </div>
        </div>
      </main>
    </div>
  );
};

export default SettingsShell;
