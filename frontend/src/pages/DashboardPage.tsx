import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  ExternalLink,
  Hammer,
  MessageCircle,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users2,
} from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsMetricCard,
  SettingsMetricsGrid,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { fetchWorkspaceOverview, type WorkspaceOverview } from '../services/settingsApi';
import { useUITheme } from '../colorMode';

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
  const [uiTheme, setUiTheme] = useUITheme();
  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadOverview = useCallback(async (isCancelled?: () => boolean) => {
    setLoading(true);
    setLoadError(null);

    try {
      const overview = await fetchWorkspaceOverview();
      if (!isCancelled?.()) {
        setData(overview);
      }
    } catch (e) {
      if (!isCancelled?.()) {
        setData(null);
        setLoadError(e instanceof Error ? e.message : 'Failed to load dashboard');
      }
    } finally {
      if (!isCancelled?.()) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadOverview(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadOverview]);

  const retryLoad = useCallback(() => {
    void loadOverview();
  }, [loadOverview]);

  const stats = useMemo(() => {
    if (!data) {
      const unavailable = Boolean(loadError) && !loading;
      const value = unavailable ? '—' : '…';
      const hint = unavailable ? 'Unavailable. Retry to refresh.' : 'Loading…';

      return [
        { label: 'Total skills', value, hint, icon: Users2, pulse: loading },
        { label: 'Users with messages (24h)', value, hint, icon: MessageCircle, pulse: loading },
        { label: 'Langfuse observations (7d)', value, hint, icon: Hammer, pulse: loading },
      ];
    }

    const { skills, users, langfuse } = data;
    const thirdHint = langfuse.configured
      ? (langfuse.available ? 'Rolling 7 days from Langfuse' : 'Could not reach Langfuse API')
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
  }, [data, loadError, loading]);

  const activities = data?.activity.items || [];
  const focusAreas = data?.focus || [];

  return (
    <SettingsShell
      eyebrow="Overview"
      title="Workspace Dashboard"
      description="Shared operational view for registry, people, knowledge, and LLM observability."
    >
      <div className="space-y-6">
        {loadError ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
            <span>Dashboard data could not be loaded. {loadError}</span>
            <button
              type="button"
              onClick={retryLoad}
              disabled={loading}
              className="settings-portal-button-secondary inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
              Retry
            </button>
          </div>
        ) : null}

        <SettingsSurface className="space-y-6">
          <SettingsSectionHeader
            eyebrow="Snapshot"
            title="Key workspace signals"
            description="Adoption, chat activity, and Langfuse-backed run volume at a glance."
          />

          <SettingsMetricsGrid className="md:grid-cols-3">
            {stats.map(({ label, value, hint, icon: Icon, pulse }) => (
              <div key={label} className={pulse ? 'animate-pulse' : undefined}>
                <SettingsMetricCard label={label} value={value} hint={hint} icon={Icon} />
              </div>
            ))}
          </SettingsMetricsGrid>

          {data?.langfuse.configured && data.langfuse.error ? (
            <p className="text-xs text-slate-500">Langfuse: {data.langfuse.error}</p>
          ) : null}

          <div className="border-t border-slate-200 pt-5">
            <SettingsSectionHeader
              eyebrow="Admin focus"
              title="What needs attention"
              description="Recommended setup, access, and content coverage actions."
            />

            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              {loading && !data ? (
                <p className="text-sm text-slate-500">Loading recommendations…</p>
              ) : null}
              {!loading && focusAreas.length === 0 ? (
                <p className="text-sm text-slate-500 lg:col-span-3">No automated recommendations right now.</p>
              ) : null}
              {focusAreas.map(({ title, description, to, action }, i) => {
                const Icon = FOCUS_ICONS[i % FOCUS_ICONS.length];
                return (
                  <div key={title} className="settings-portal-card rounded-2xl p-4">
                    <div className="flex items-start gap-3">
                      <span className="settings-portal-icon-muted inline-flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-slate-200">
                        <Icon size={17} />
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
          </div>
        </SettingsSurface>

        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Activity"
            title="Recent activity"
            description="In-app messages and Langfuse traces when the API is reachable."
            actions={data?.langfuse.publicUrl ? (
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
          />
          <div className="mt-6 space-y-3">
            {loading && activities.length === 0 ? (
              <p className="text-sm text-slate-500">Loading recent activity…</p>
            ) : null}
            {!loading && activities.length === 0 ? (
              <SettingsEmptyState
                title="No recent activity yet"
                description="Start a chat or run the agent to populate this list."
                icon={Activity}
                action={(
                  <Link
                    to="/settings/agents"
                    className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition"
                  >
                    Manage skills
                  </Link>
                )}
              />
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

        <SettingsSurface className="space-y-6">
          <SettingsSectionHeader
            eyebrow="Appearance"
            title="Workspace theme"
            description="Choose the visual style for this workspace."
          />

          <div className="grid gap-4 md:grid-cols-3">
            <button
              type="button"
              onClick={() => setUiTheme('standard')}
              className={`group relative flex flex-col items-start rounded-2xl border-2 p-5 text-left transition-all duration-300 ${
                uiTheme === 'standard'
                  ? 'border-blue-600 bg-blue-50/20 shadow-lg shadow-blue-500/5 dark:border-blue-500 dark:bg-blue-950/20'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                  <Palette size={18} />
                </span>
                {uiTheme === 'standard' ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : null}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">Standard</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Soft shadows, balanced contours, sapphire accents, and fluid layouts.
              </p>
              <div className="mt-5 flex w-full items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="flex gap-1.5">
                  <span className="h-4 w-4 rounded-full bg-[#2563eb]" />
                  <span className="h-4 w-4 rounded-full border border-slate-200 bg-[#f8fafc] dark:border-slate-700" />
                  <span className="h-4 w-4 rounded-full bg-[#0f172a] dark:bg-slate-950" />
                </div>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1 dark:border-slate-800 dark:bg-slate-950">
                  <span className="h-2 w-2 rounded-full bg-blue-600" />
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Default</span>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setUiTheme('minimalism')}
              className={`group relative flex flex-col items-start rounded-2xl border-2 p-5 text-left transition-all duration-300 ${
                uiTheme === 'minimalism'
                  ? 'border-neutral-900 bg-neutral-100/40 dark:border-neutral-200 dark:bg-neutral-900/20'
                  : 'border-slate-200 bg-white hover:border-neutral-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-neutral-500'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
                  <Palette size={18} />
                </span>
                {uiTheme === 'minimalism' ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-black">
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : null}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">Minimalism</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Monochrome surfaces, compact controls, generous whitespace, and restrained corners.
              </p>
              <div className="mt-5 flex w-full items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="flex gap-1">
                  <span className="h-3 w-6 rounded-sm bg-[#171717] dark:bg-white" />
                  <span className="h-3 w-6 rounded-sm border border-neutral-200 bg-[#f5f5f5] dark:border-neutral-700 dark:bg-neutral-800" />
                </div>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-1 dark:border-neutral-800 dark:bg-neutral-950">
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Quiet</span>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setUiTheme('bauhaus')}
              className={`group relative flex flex-col items-start rounded-2xl border-2 p-5 text-left transition-all duration-300 ${
                uiTheme === 'bauhaus'
                  ? 'border-black bg-[#f3efe0] shadow-[4px_4px_0px_currentColor] dark:border-white dark:bg-neutral-900'
                  : 'border-slate-200 bg-white hover:border-black hover:shadow-[3px_3px_0px_currentColor] dark:border-slate-800 dark:bg-slate-900 dark:hover:border-white'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border-2 border-black bg-[#fcbf49] text-black dark:border-white">
                  <Palette size={18} />
                </span>
                {uiTheme === 'bauhaus' ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-black bg-[#d62828] text-white dark:border-white">
                    <Check size={10} strokeWidth={4} />
                  </span>
                ) : null}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">Bauhaus</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Flat surfaces, sharp geometry, stronger gridlines, and bold primary color accents.
              </p>
              <div className="mt-5 flex w-full items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="flex gap-1">
                  <span className="h-4 w-4 border border-black bg-[#d62828] dark:border-white" />
                  <span className="h-4 w-4 border border-black bg-[#fcbf49] dark:border-white" />
                  <span className="h-4 w-4 border border-black bg-[#003049] dark:border-white" />
                </div>
                <div className="ml-auto flex items-center rounded-lg border border-slate-200 bg-white px-2 py-0.5 dark:border-slate-700 dark:bg-neutral-950">
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Flat</span>
                </div>
              </div>
            </button>
          </div>
        </SettingsSurface>
      </div>
    </SettingsShell>
  );
};

export default DashboardPage;
