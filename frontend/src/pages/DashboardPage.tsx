import { Link } from 'react-router-dom';
import { Users2, Hammer, MessageCircle, Activity, Sparkles, ArrowRight, ShieldCheck, BookOpen } from 'lucide-react';
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

  const focusAreas = [
    {
      title: 'Seed core skills',
      description: 'The registry is still empty. Add starter skills so the workspace feels ready on first use.',
      to: '/settings/agents',
      action: 'Open skill registry',
      icon: Sparkles,
    },
    {
      title: 'Audit access coverage',
      description: 'Only one user is active in the last 24 hours. Verify admin coverage and group mappings.',
      to: '/settings/users',
      action: 'Review users',
      icon: ShieldCheck,
    },
    {
      title: 'Track knowledge readiness',
      description: 'Make ingestion health visible so indexed content is easy to trust and troubleshoot.',
      to: '/settings/knowledge',
      action: 'Review knowledge',
      icon: BookOpen,
    },
  ];

  return (
    <SettingsShell
      eyebrow="Overview"
      title="Workspace Dashboard"
      description="Shared operational view for registry, people, knowledge, and tooling health."
    >
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-[1.45fr_0.95fr]">
          <SettingsSurface className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="settings-portal-chip inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
                Live workspace
              </span>
              <span className="inline-flex rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                Operations focus
              </span>
            </div>
            <SettingsSectionHeader
              eyebrow="Snapshot"
              title="Key workspace signals"
              description="A compact read on adoption, tooling activity, and admin readiness."
            />
            <SettingsMetricsGrid className="md:grid-cols-3">
              {stats.map(({ label, value, hint, icon: Icon }) => (
                <SettingsMetricCard key={label} label={label} value={value} hint={hint} icon={Icon} />
              ))}
            </SettingsMetricsGrid>
          </SettingsSurface>

          <SettingsSurface className="space-y-5">
            <SettingsSectionHeader
              eyebrow="Admin focus"
              title="What needs attention"
              description="Use the admin portal to tighten setup, access, and content coverage."
            />
            <div className="space-y-3">
              {focusAreas.map(({ title, description, to, action, icon: Icon }) => (
                <div key={title} className="settings-portal-card rounded-[22px] p-4">
                  <div className="flex items-start gap-4">
                    <span className="settings-portal-icon-muted inline-flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ring-slate-200">
                      <Icon size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900">{title}</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
                      <Link
                        to={to}
                        className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-blue-600 transition hover:text-blue-700"
                      >
                        {action}
                        <ArrowRight size={16} />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SettingsSurface>
        </div>

        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Activity"
            title="Recent activity"
            description="Stay on top of what changed across your workspace."
            actions={(
              <Link
                to="/settings/agents"
                className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium transition"
              >
                Manage skills
              </Link>
            )}
          />
          <div className="mt-6 space-y-3">
            {activities.map(({ title, meta, icon: Icon }) => (
              <div key={title} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                <span className="settings-portal-icon-muted inline-flex h-10 w-10 items-center justify-center rounded-2xl ring-1 ring-slate-200">
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
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
