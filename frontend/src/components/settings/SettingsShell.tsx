import { useMemo, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users2,
  BookOpen,
  CreditCard,
  MessageCircle,
  ArrowLeftCircle,
  PanelLeft,
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
  { label: 'Skills & Tools', icon: Users2, path: '/settings/agents' },
  { label: 'Knowledge', icon: BookOpen, path: '/settings/knowledge' },
  { label: 'Users', icon: MessageCircle, path: '/settings/users' },
  { label: 'Billing', icon: CreditCard, path: '/settings/billing' },
];

const SettingsShell = ({ title, description, eyebrow = 'Workspace settings', actions, children }: SettingsShellProps) => {
  const location = useLocation();

  const navItems = useMemo(() => BASE_NAV_ITEMS, []);
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
      <aside className="settings-portal-sidebar border-b lg:flex lg:min-h-screen lg:w-72 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-100 px-6 py-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Workspace settings</p>
          <div className="mt-3 flex items-start gap-3">
            <span className="settings-portal-icon inline-flex h-11 w-11 items-center justify-center rounded-2xl">
              <PanelLeft size={18} />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-slate-900">Admin Portal</h1>
              <p className="mt-1 text-sm leading-6 text-slate-500">Unified settings, people, and knowledge controls.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="settings-portal-chip inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
                  Shared system
                </span>
                <span className="inline-flex rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  Operational view
                </span>
              </div>
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-x-auto p-4">
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
                  className={`settings-portal-nav-item flex min-w-fit items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${isActive
                    ? 'settings-portal-nav-item-active'
                    : ''
                    }`}
                >
                  <Icon size={16} />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6 xl:px-10 2xl:px-12">
          <div className="space-y-5">
            <div className="settings-portal-header rounded-[28px] p-5 sm:p-6">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="settings-portal-chip inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]">
                      {eyebrow}
                    </span>
                    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                      Unified admin surface
                    </span>
                  </div>
                  <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[2rem]">{title}</h2>
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
