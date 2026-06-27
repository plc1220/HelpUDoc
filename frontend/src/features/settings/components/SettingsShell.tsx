import { useMemo, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users2,
  BookOpen,
  CreditCard,
  MessageCircle,
  ArrowLeftCircle,
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
      <aside className="settings-portal-sidebar border-b lg:flex lg:min-h-screen lg:w-64 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-100 px-4 py-4 sm:px-5">
          <h1 className="text-sm font-semibold text-slate-900">Settings</h1>
        </div>
        <nav className="flex-1 overflow-x-auto p-3">
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
                  className={`settings-portal-nav-item flex min-w-fit items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive
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
