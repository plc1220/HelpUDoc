import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users2, Hammer, MessageCircle, Activity, Sparkles, ArrowRight, ShieldCheck, BookOpen, ExternalLink, Palette, Check } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
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

        {/* Theme Selection */}
        <SettingsSurface className="space-y-6">
          <SettingsSectionHeader
            eyebrow="Aesthetics"
            title="Workspace Theme"
            description="Personalize your workflow and dashboard layout. Switch between three carefully crafted visual designs."
          />
          <div className="grid gap-6 md:grid-cols-3">
            {/* Standard Theme Card */}
            <button
              onClick={() => setUiTheme('standard')}
              className={`group relative flex flex-col items-start rounded-2xl p-5 text-left border-2 transition-all duration-300 ${
                uiTheme === 'standard'
                  ? 'border-blue-600 dark:border-blue-500 bg-blue-50/20 dark:bg-blue-950/20 shadow-lg shadow-blue-500/5'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-md'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                  <Palette size={18} />
                </span>
                {uiTheme === 'standard' && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">Standard</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                The classic corporate aesthetic. Soft shadows, balanced contours, sleek sapphire accents, and fluid layouts.
              </p>

              <div className="mt-5 flex items-center gap-3 w-full border-t border-slate-100 dark:border-slate-800 pt-4">
                <div className="flex gap-1.5">
                  <span className="h-4 w-4 rounded-full bg-[#2563eb]" />
                  <span className="h-4 w-4 rounded-full bg-[#f8fafc] border border-slate-200 dark:border-slate-700" />
                  <span className="h-4 w-4 rounded-full bg-[#0f172a] dark:bg-slate-950" />
                </div>
                <div className="ml-auto flex items-center gap-1 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-100 dark:border-slate-800">
                  <span className="h-2 w-2 rounded-full bg-blue-600" />
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Default MUI</span>
                </div>
              </div>
            </button>

            {/* Minimalism Theme Card */}
            <button
              onClick={() => setUiTheme('minimalism')}
              className={`group relative flex flex-col items-start rounded-xl p-5 text-left border transition-all duration-300 ${
                uiTheme === 'minimalism'
                  ? 'border-neutral-900 dark:border-neutral-200 bg-neutral-100/40 dark:bg-neutral-900/20'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-neutral-400 dark:hover:border-neutral-500'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100">
                  <Palette size={18} />
                </span>
                {uiTheme === 'minimalism' && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-black">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </div>
              <h3 className="mt-4 text-base font-light tracking-tight text-neutral-900 dark:text-neutral-100 lowercase">minimalism</h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed lowercase">
                quiet monochrome surfaces, compact controls, generous whitespace, and restrained geometric corners.
              </p>

              <div className="mt-5 flex items-center gap-3 w-full border-t border-neutral-100 dark:border-neutral-800 pt-4">
                <div className="flex gap-1">
                  <span className="h-3 w-6 rounded-sm bg-[#171717] dark:bg-white" />
                  <span className="h-3 w-6 rounded-sm bg-[#f5f5f5] dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700" />
                </div>
                <div className="ml-auto flex items-center gap-1 bg-neutral-50 dark:bg-neutral-950 px-3 py-1 rounded-md border border-neutral-100 dark:border-neutral-800">
                  <span className="text-[9px] font-medium tracking-wider text-neutral-500 dark:text-neutral-400 lowercase">quiet</span>
                </div>
              </div>
            </button>

            {/* Bauhaus Theme Card */}
            <button
              onClick={() => setUiTheme('bauhaus')}
              className={`group relative flex flex-col items-start p-5 text-left border-[2.5px] transition-all duration-300 ${
                uiTheme === 'bauhaus'
                  ? 'border-black dark:border-white bg-[#f3efe0] dark:bg-neutral-900 shadow-[4px_4px_0px_currentColor]'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-black dark:hover:border-white hover:shadow-[3px_3px_0px_currentColor]'
              }`}
              style={{ borderRadius: '0px' }}
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-9 w-9 items-center justify-center border-2 border-black dark:border-white bg-[#fcbf49] text-black" style={{ borderRadius: '0px' }}>
                  <Palette size={18} />
                </span>
                {uiTheme === 'bauhaus' && (
                  <span className="flex h-5 w-5 items-center justify-center border-2 border-black dark:border-white bg-[#d62828] text-white" style={{ borderRadius: '0px' }}>
                    <Check size={10} strokeWidth={4} />
                  </span>
                )}
              </div>
              <h3 className="mt-4 text-base font-extrabold uppercase tracking-wider text-black dark:text-white">BAUHAUS</h3>
              <p className="mt-1 text-xs text-black/80 dark:text-white/80 leading-relaxed uppercase font-medium">
                artistic flat brutalism. sharp geometric corners, heavy gridlines, and bold primary color accents.
              </p>

              <div className="mt-5 flex items-center gap-2 w-full border-t-2 border-black dark:border-white pt-4">
                <div className="flex gap-1">
                  <span className="h-4 w-4 bg-[#d62828] border border-black dark:border-white" style={{ borderRadius: '0px' }} />
                  <span className="h-4 w-4 bg-[#fcbf49] border border-black dark:border-white" style={{ borderRadius: '0px' }} />
                  <span className="h-4 w-4 bg-[#003049] border border-black dark:border-white" style={{ borderRadius: '0px' }} />
                </div>
                <div className="ml-auto flex items-center border-2 border-black dark:border-white bg-white dark:bg-neutral-950 px-2 py-0.5" style={{ borderRadius: '0px' }}>
                  <span className="text-[9px] font-black tracking-widest text-black dark:text-white">FLAT</span>
                </div>
              </div>
            </button>
          </div>
        </SettingsSurface>

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
