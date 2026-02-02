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

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="w-64 border-r border-slate-200 bg-white/95 backdrop-blur flex flex-col">
        <div className="p-6 border-b border-slate-100">
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Workspace settings</p>
          <h1 className="text-xl font-semibold text-slate-900 mt-1">Admin Portal</h1>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(({ label, icon: Icon, path }) => {
            const isActive = path === '/settings'
              ? location.pathname === path
              : location.pathname.startsWith(path);

            return (
              <Link
                key={label}
                to={path}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${isActive
                  ? 'bg-slate-900 text-white shadow-sm ring-1 ring-slate-900/5'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-100">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 transition-colors">
            <ArrowLeftCircle size={16} />
            Back to Workspace
          </Link>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-gradient-to-br from-slate-50 via-white to-slate-100">
        <div className="mx-auto max-w-6xl px-8 py-12 space-y-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-slate-500">{eyebrow}</p>
            <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-slate-900">{title}</h2>
                {description && <p className="text-slate-600 mt-2 max-w-2xl">{description}</p>}
              </div>
              {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
            </div>
          </div>

          {children}
        </div>
      </main>
    </div>
  );
};

export default SettingsShell;
