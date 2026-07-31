import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users2,
  BookOpen,
  CreditCard,
  MessageCircle,
  ArrowLeftCircle,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
} from 'lucide-react';

type NavItem = {
  label: string;
  path: string;
  icon: ComponentType<{ size?: number }>;
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
  { label: 'Skill Governance', icon: ShieldCheck, path: '/skills' },
  { label: 'Skills & Tools', icon: Users2, path: '/settings/agents' },
  { label: 'Knowledge', icon: BookOpen, path: '/settings/knowledge' },
  { label: 'Users', icon: MessageCircle, path: '/settings/users' },
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

  const navItems = useMemo(() => BASE_NAV_ITEMS, []);
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
    <Link
      to="/"
      className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors"
    >
      <ArrowLeftCircle size={16} />
      Back to Workspace
    </Link>
  );

  return (
    <div className="settings-portal min-h-screen lg:flex">
      <aside
        className={`settings-portal-sidebar border-b transition-[width] duration-200 ease-out lg:flex lg:min-h-screen lg:flex-col lg:border-b-0 lg:border-r ${
          isNavigationCollapsed ? 'lg:w-[72px]' : 'lg:w-64'
        }`}
      >
        <div
          className={`flex min-h-[53px] items-center border-b border-slate-100 px-4 py-3 ${
            isNavigationCollapsed ? 'lg:justify-center lg:px-2' : 'justify-between sm:px-5'
          }`}
        >
          <h1 className={`text-sm font-semibold text-slate-900 ${isNavigationCollapsed ? 'lg:hidden' : ''}`}>
            Settings
          </h1>
          <button
            type="button"
            onClick={toggleNavigation}
            className="settings-portal-button-secondary hidden h-8 w-8 items-center justify-center rounded-lg transition-colors lg:inline-flex"
            aria-label={isNavigationCollapsed ? 'Expand settings navigation' : 'Collapse settings navigation'}
            title={isNavigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {isNavigationCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        <nav
          className={`flex-1 overflow-x-auto p-3 ${
            isNavigationCollapsed ? 'lg:px-2' : ''
          }`}
          aria-label="Settings navigation"
        >
          <div className="flex gap-2 lg:block lg:space-y-1">
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
                  className={`settings-portal-nav-item flex min-w-fit items-center rounded-lg py-2 text-sm font-medium transition-colors ${
                    isNavigationCollapsed ? 'gap-3 px-3 lg:justify-center lg:gap-0 lg:px-2' : 'gap-3 px-3'
                  } ${isActive ? 'settings-portal-nav-item-active' : ''}`}
                >
                  <Icon size={16} />
                  <span className={isNavigationCollapsed ? 'lg:hidden' : ''}>{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
          <div className="space-y-6">
            <div className="border-b border-slate-200 pb-4">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">{eyebrow}</p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{title}</h2>
                  {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{description}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-3 xl:justify-end">
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
