import { Link } from 'react-router-dom';
import { Users2, Hammer, MessageCircle, Activity, Sparkles } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsMetricCard,
  SettingsMetricsGrid,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';

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
        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Snapshot"
            title="Key workspace signals"
            description="A compact overview of usage, adoption, and tool activity across the admin portal."
          />
          <SettingsMetricsGrid className="mt-6 md:grid-cols-3">
            {stats.map(({ label, value, hint, icon: Icon }) => (
              <SettingsMetricCard key={label} label={label} value={value} hint={hint} icon={Icon} />
            ))}
          </SettingsMetricsGrid>
        </SettingsSurface>

        <SettingsSurface>
          <SettingsSectionHeader
            title="Recent activity"
            description="Stay on top of what changed across your workspace."
            actions={(
              <Link
                to="/settings/agents"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
              >
                Manage skills
              </Link>
            )}
          />
          <div className="mt-6 divide-y divide-slate-200">
            {activities.map(({ title, meta, icon: Icon }) => (
              <div key={title} className="flex items-center gap-3 py-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                  <Icon size={18} />
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-900">{title}</p>
                  <p className="text-xs text-slate-500">{meta}</p>
                </div>
              </div>
            ))}
          </div>
        </SettingsSurface>
      </div>
    </SettingsShell>
  );
};

export default DashboardPage;
