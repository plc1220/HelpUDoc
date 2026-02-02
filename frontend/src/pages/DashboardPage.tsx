import { Link } from 'react-router-dom';
import { Users2, Hammer, MessageCircle, Activity, Sparkles } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';

const DashboardPage = () => {
  const stats = [
    { label: 'Total Skills', value: '0', hint: 'Skill registry size', icon: Users2 },
    { label: 'Active Users', value: '1', hint: 'Last 24 hours', icon: MessageCircle },
    { label: 'Tool Calls', value: '124', hint: 'This week', icon: Hammer },
  ];

  const activities = [
    { title: 'Skill registry refreshed', meta: '2m ago • general-assistant', icon: Sparkles },
    { title: 'Tool call spike detected', meta: '1h ago • PDF Reader', icon: Activity },
    { title: 'New user invited', meta: 'Yesterday • sso-signup', icon: MessageCircle },
  ];

  return (
    <SettingsShell
      eyebrow="Overview"
      title="Workspace Dashboard"
      description="Pulse for your admin portal with quick access to skills, users, and tools."
    >
      <div className="space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {stats.map(({ label, value, hint, icon: Icon }) => (
              <div
                key={label}
                className="flex items-start justify-between gap-3 rounded-2xl border border-slate-100 bg-gradient-to-br from-slate-50 via-white to-slate-50 p-5 shadow-[0_6px_18px_rgba(15,23,42,0.06)]"
              >
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-900">{value}</p>
                  <p className="text-sm text-slate-500 mt-1">{hint}</p>
                </div>
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white shadow-sm">
                  <Icon size={18} />
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Recent Activity</h3>
              <p className="text-sm text-slate-600">Stay on top of what changed across your workspace.</p>
            </div>
            <Link
              to="/settings/agents"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
            >
              Manage skills
            </Link>
          </div>
          <div className="mt-4 divide-y divide-slate-200">
            {activities.map(({ title, meta, icon: Icon }) => (
              <div key={title} className="flex items-center gap-3 py-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                  <Icon size={18} />
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-900">{title}</p>
                  <p className="text-xs text-slate-500">{meta}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </SettingsShell>
  );
};

export default DashboardPage;
