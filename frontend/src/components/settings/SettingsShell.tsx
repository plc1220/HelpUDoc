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
      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:text-slate-900"
    >
      <ArrowLeftCircle size={16} />
      Back to Workspace
    </Link>
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(148,163,184,0.14),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2f7_100%)] lg:flex">
      <aside className="border-b border-slate-200/80 bg-white/90 backdrop-blur lg:flex lg:min-h-screen lg:w-72 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-100 px-6 py-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Workspace settings</p>
          <div className="mt-2 flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-sm">
              <PanelLeft size={18} />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Admin Portal</h1>
              <p className="text-sm text-slate-500">Unified settings, people, and knowledge controls.</p>
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
                  className={`flex min-w-fit items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${isActive
                    ? 'bg-slate-900 text-white shadow-sm ring-1 ring-slate-900/5'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
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
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:px-10 2xl:px-12">
          <div className="space-y-6">
            <div className="rounded-[32px] border border-slate-200/80 bg-white/92 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.08)] backdrop-blur sm:p-8">
              <p className="text-xs uppercase tracking-wide text-slate-500">{eyebrow}</p>
              <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-2xl font-semibold text-slate-900 sm:text-[2rem]">{title}</h2>
                  {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{description}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-3">
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
