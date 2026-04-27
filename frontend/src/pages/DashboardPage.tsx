import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users2, Hammer, MessageCircle, Activity, Sparkles, ArrowRight, ShieldCheck, BookOpen, ExternalLink } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsMetricCard,
  SettingsMetricsGrid,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { fetchWorkspaceOverview, type WorkspaceOverview } from '../services/settingsApi';

const FOCUS_ICONS = [Sparkles, ShieldCheck, BookOpen] as const;

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

const DashboardPage = () => {
  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const overview = await fetchWorkspaceOverview();
        if (!cancelled) {
          setData(overview);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    if (!data) {
      return [
        { label: 'Total skills', value: '…', hint: 'Skill registry size', icon: Users2, pulse: true },
        { label: 'Users with messages (24h)', value: '…', hint: 'Distinct chat authors', icon: MessageCircle, pulse: true },
        { label: 'Langfuse observations (7d)', value: '…', hint: 'Model and tool steps', icon: Hammer, pulse: true },
      ];
    }
    const { skills, users, langfuse } = data;
    const thirdHint = langfuse.configured
      ? (langfuse.available ? 'Rolling 7 days · from Langfuse' : 'Could not reach Langfuse API')
      : 'Set LANGFUSE_* on the server to enable';
    const thirdValue = !langfuse.configured
      ? '—'
      : (!langfuse.available && langfuse.observations7d === 0 ? '—' : String(langfuse.observations7d));
    return [
      {
        label: 'Total skills',
        value: String(skills.count),
        hint: 'Skill registry size',
        icon: Users2,
        pulse: false,
      },
      {
        label: 'Users with messages (24h)',
        value: String(users.messaged24h),
        hint: `${users.total} registered total`,
        icon: MessageCircle,
        pulse: false,
      },
      {
        label: 'Langfuse observations (7d)',
        value: thirdValue,
        hint: thirdHint,
        icon: Hammer,
        pulse: false,
      },
    ];
  }, [data]);

  const activities = data?.activity.items || [];
  const focusAreas = data?.focus || [];

  return (
    <SettingsShell
      eyebrow="Overview"
      title="Workspace Dashboard"
      description="Shared operational view for registry, people, knowledge, and LLM observability (Langfuse when configured)."
    >
      <div className="space-y-6">
        {loadError ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950">
            {loadError}
          </div>
        ) : null}

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
              description="A compact read on adoption, chat activity, and Langfuse-backed run volume."
            />
            <SettingsMetricsGrid className="md:grid-cols-3">
              {stats.map(({ label, value, hint, icon: Icon, pulse }) => (
                <div key={label} className={pulse ? 'animate-pulse' : undefined}>
                  <SettingsMetricCard label={label} value={value} hint={hint} icon={Icon} />
                </div>
              ))}
            </SettingsMetricsGrid>
            {data?.langfuse.configured && data.langfuse.error ? (
              <p className="text-xs text-slate-500">
                Langfuse: {data.langfuse.error}
              </p>
            ) : null}
          </SettingsSurface>

          <SettingsSurface className="space-y-5">
            <SettingsSectionHeader
              eyebrow="Admin focus"
              title="What needs attention"
              description="Use the admin portal to tighten setup, access, and content coverage."
            />
            <div className="space-y-3">
              {loading && !data ? (
                <p className="text-sm text-slate-500">Loading recommendations…</p>
              ) : null}
              {!loading && focusAreas.length === 0 ? (
                <p className="text-sm text-slate-500">No automated recommendations right now.</p>
              ) : null}
              {focusAreas.map(({ title, description, to, action }, i) => {
                const Icon = FOCUS_ICONS[i % FOCUS_ICONS.length];
                return (
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
                );
              })}
            </div>
          </SettingsSurface>
        </div>

        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Activity"
            title="Recent activity"
            description="In-app messages and the latest Langfuse traces when the API is reachable."
            actions={(
              <div className="flex flex-wrap items-center gap-2">
                {data?.langfuse.publicUrl ? (
                  <a
                    href={data.langfuse.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium transition"
                  >
                    Open Langfuse
                    <ExternalLink size={16} />
                  </a>
                ) : null}
                <Link
                  to="/settings/agents"
                  className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium transition"
                >
                  Manage skills
                </Link>
              </div>
            )}
          />
          <div className="mt-6 space-y-3">
            {loading && activities.length === 0 ? (
              <p className="text-sm text-slate-500">Loading recent activity…</p>
            ) : null}
            {!loading && activities.length === 0 ? (
              <p className="text-sm text-slate-500">No recent activity yet. Start a chat or run the agent to populate this list.</p>
            ) : null}
            {activities.map((a) => {
              const rel = formatRelativeTime(a.at);
              const icon = a.source === 'langfuse' ? Activity : a.meta.includes('agent') ? MessageCircle : Sparkles;
              const Icon = icon;
              return (
                <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                  <span className="settings-portal-icon-muted inline-flex h-10 w-10 items-center justify-center rounded-2xl ring-1 ring-slate-200">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{a.title}</p>
                    <p className="text-xs text-slate-500">
                      {rel ? `${rel} · ` : ''}
                      {a.meta}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsSurface>
      </div>
    </SettingsShell>
  );
};

export default DashboardPage;
