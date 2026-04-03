import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpenText,
  Calendar,
  Lightbulb,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users2,
  Wrench,
} from 'lucide-react';
import type { DailyReflection, ReflectionBreakdown, ReflectionTrendPoint } from '../types';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsMetricCard,
  SettingsMetricsGrid,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { generateReflection, getDailyReflection, getReflectionTrends } from '../services/reflectionApi';

const DIMENSION_OPTIONS: Array<ReflectionBreakdown['dimension']> = ['skill', 'tool', 'user', 'workspace'];

const metricNumber = (metrics: Record<string, unknown> | undefined, key: string): number => {
  const value = metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const formatReflectionDate = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const scorecardMeta = [
  { key: 'outcome', label: 'Outcome', hint: 'Completion strength', icon: Sparkles },
  { key: 'reliability', label: 'Reliability', hint: 'Failure + tool stability', icon: ShieldCheck },
  { key: 'friction', label: 'Friction', hint: 'Interrupts + run smoothness', icon: TrendingUp },
] as const;

export default function DashboardPage() {
  const [selectedDate, setSelectedDate] = useState('');
  const [reflection, setReflection] = useState<DailyReflection | null>(null);
  const [trends, setTrends] = useState<ReflectionTrendPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeDimension, setActiveDimension] = useState<ReflectionBreakdown['dimension']>('skill');

  const loadDashboard = async (date?: string) => {
    setIsLoading(true);
    try {
      const [nextReflection, nextTrends] = await Promise.all([
        getDailyReflection(date),
        getReflectionTrends(14),
      ]);
      setReflection(nextReflection);
      setTrends(nextTrends);
      if (nextReflection?.reflectionDate) {
        setSelectedDate(nextReflection.reflectionDate);
      }
    } catch (error) {
      console.error('Failed to load reflection dashboard', error);
      setReflection(null);
      setTrends([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const generated = await generateReflection(selectedDate || undefined);
      setReflection(generated);
      setSelectedDate(generated.reflectionDate);
      setTrends(await getReflectionTrends(14));
    } catch (error) {
      console.error('Failed to generate reflection', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const breakdowns = useMemo(
    () => (reflection?.breakdowns || []).filter((item) => item.dimension === activeDimension),
    [activeDimension, reflection],
  );

  const stats = reflection
    ? [
        { label: 'Runs', value: String(metricNumber(reflection.metrics, 'totalRuns')), hint: 'Observed in snapshot', icon: MessageCircle },
        { label: 'Completed', value: String(metricNumber(reflection.metrics, 'completedRuns')), hint: 'Successful runs', icon: Sparkles },
        { label: 'Failures', value: String(metricNumber(reflection.metrics, 'failedRuns')), hint: 'Need investigation', icon: AlertTriangle },
        { label: 'Tool Calls', value: String(metricNumber(reflection.metrics, 'toolCallCount')), hint: 'Across all runs', icon: Wrench },
      ]
    : [];

  return (
    <SettingsShell
      eyebrow="Overview"
      title="Workspace Dashboard"
      description="Nightly operational reflection for agent performance, friction, and improvement opportunities."
    >
      <div className="space-y-6">
        <SettingsSurface className="space-y-5">
          <SettingsSectionHeader
            eyebrow="Reflection"
            title="Daily Admin Reflection"
            description="Snapshot-based view of agent efficiency, reliability, and where the tooling or skill layer should improve next."
            actions={(
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm"
                />
                <button
                  type="button"
                  onClick={() => void loadDashboard(selectedDate || undefined)}
                  className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium"
                >
                  <Calendar size={15} />
                  Load
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="settings-portal-button-primary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  <RefreshCw size={15} className={isGenerating ? 'animate-spin' : ''} />
                  {isGenerating ? 'Generating...' : 'Regenerate'}
                </button>
              </div>
            )}
          />

          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-slate-500">
              <RefreshCw size={18} className="mr-2 animate-spin" />
              Loading reflection snapshot...
            </div>
          ) : !reflection ? (
            <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/70 px-6 py-12 text-center">
              <Calendar size={28} className="mx-auto mb-3 text-slate-300" />
              <p className="text-sm font-medium text-slate-700">No reflection snapshot yet</p>
              <p className="mt-1 text-sm text-slate-500">
                Generate a nightly reflection to populate trend lines, scorecards, and drilldowns.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="rounded-[24px] border border-slate-200 bg-slate-50/70 px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Snapshot Date</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {formatReflectionDate(reflection.reflectionDate)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">Timezone: {reflection.timezone}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {scorecardMeta.map(({ key, label, icon: Icon }) => (
                      <div
                        key={key}
                        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
                      >
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                          <Icon size={14} />
                          {label}
                        </div>
                        <div className="mt-2 text-2xl font-semibold text-slate-900">
                          {reflection.scorecard[key]}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <SettingsMetricsGrid className="md:grid-cols-4">
                {stats.map(({ label, value, hint, icon: Icon }) => (
                  <SettingsMetricCard key={label} label={label} value={value} hint={hint} icon={Icon} />
                ))}
              </SettingsMetricsGrid>

              <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                <SettingsSurface className="space-y-4">
                  <SettingsSectionHeader
                    eyebrow="Narrative"
                    title="Daily diagnosis"
                    description="AI-written reflection grounded in the immutable run telemetry snapshot."
                  />
                  <div className="prose prose-sm max-w-none text-slate-700 prose-headings:text-slate-900 prose-p:text-slate-700 prose-strong:text-slate-900">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {reflection.summaryMarkdown || 'No summary available.'}
                    </ReactMarkdown>
                  </div>
                </SettingsSurface>

                <SettingsSurface className="space-y-4">
                  <SettingsSectionHeader
                    eyebrow="Recommendations"
                    title="Where to improve next"
                    description="Concrete follow-up items inferred from the day’s failure modes and friction patterns."
                  />
                  <div className="space-y-3">
                    {(reflection.recommendations || []).map((item) => (
                      <div key={item.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <div className="flex items-start gap-3">
                          <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${
                            item.priority === 'high'
                              ? 'bg-red-50 text-red-600'
                              : item.priority === 'medium'
                                ? 'bg-amber-50 text-amber-600'
                                : 'bg-emerald-50 text-emerald-600'
                          }`}>
                            {item.priority === 'high' ? <AlertTriangle size={16} /> : item.priority === 'medium' ? <Lightbulb size={16} /> : <TrendingUp size={16} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                            <p className="mt-1 text-sm leading-6 text-slate-600">{item.detail}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </SettingsSurface>
              </div>

              <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                <SettingsSurface className="space-y-4">
                  <SettingsSectionHeader
                    eyebrow="Trendline"
                    title="Recent score history"
                    description="Past two weeks of stored daily snapshots."
                  />
                  <div className="space-y-3">
                    {trends.map((point) => (
                      <div key={point.reflectionDate} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{formatReflectionDate(point.reflectionDate)}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">{point.timezone}</p>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-xl bg-slate-50 px-3 py-2">
                              <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Outcome</p>
                              <p className="text-sm font-semibold text-slate-900">{point.scorecard.outcome}</p>
                            </div>
                            <div className="rounded-xl bg-slate-50 px-3 py-2">
                              <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Reliability</p>
                              <p className="text-sm font-semibold text-slate-900">{point.scorecard.reliability}</p>
                            </div>
                            <div className="rounded-xl bg-slate-50 px-3 py-2">
                              <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Friction</p>
                              <p className="text-sm font-semibold text-slate-900">{point.scorecard.friction}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </SettingsSurface>

                <SettingsSurface className="space-y-4">
                  <SettingsSectionHeader
                    eyebrow="Drilldowns"
                    title="Dimension breakdowns"
                    description="Top contributors by skill, tool, user, and workspace."
                  />
                  <div className="flex flex-wrap gap-2">
                    {DIMENSION_OPTIONS.map((dimension) => (
                      <button
                        key={dimension}
                        type="button"
                        onClick={() => setActiveDimension(dimension)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${
                          activeDimension === dimension
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {dimension}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-3">
                    {breakdowns.slice(0, 8).map((item) => (
                      <div key={`${item.dimension}-${item.entityKey}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                              Rank #{item.rank}
                            </p>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-xl bg-slate-50 px-2 py-2">
                              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Runs</p>
                              <p className="text-sm font-semibold text-slate-900">{metricNumber(item.metrics, 'totalRuns')}</p>
                            </div>
                            <div className="rounded-xl bg-slate-50 px-2 py-2">
                              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Done</p>
                              <p className="text-sm font-semibold text-slate-900">{metricNumber(item.metrics, 'completedRuns')}</p>
                            </div>
                            <div className="rounded-xl bg-slate-50 px-2 py-2">
                              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Tool Err</p>
                              <p className="text-sm font-semibold text-slate-900">{metricNumber(item.metrics, 'toolErrorCount')}</p>
                            </div>
                          </div>
                        </div>
                        {item.summary ? <p className="mt-3 text-sm text-slate-600">{item.summary}</p> : null}
                      </div>
                    ))}
                  </div>
                </SettingsSurface>
              </div>

              <SettingsSurface className="space-y-4">
                <SettingsSectionHeader
                  eyebrow="Samples"
                  title="Representative conversations"
                  description="Small set of referenced conversations used to ground the daily reflection."
                />
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {(reflection.sampledConversations || []).map((sample) => (
                    <div key={`${sample.conversationId}-${sample.status}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-slate-500">
                        <BookOpenText size={13} />
                        {sample.status}
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{sample.title || sample.conversationId}</p>
                      <div className="mt-2 space-y-1 text-xs text-slate-500">
                        <p>{sample.workspaceName || 'Unknown workspace'}</p>
                        <p>{sample.userDisplayName || 'Unknown user'}</p>
                      </div>
                      {sample.excerpt ? (
                        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-600">{sample.excerpt}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </SettingsSurface>
            </div>
          )}
        </SettingsSurface>

        <div className="grid gap-6 xl:grid-cols-3">
          <SettingsMetricCard
            label="Active Users"
            value={String(metricNumber(reflection?.metrics, 'uniqueUsers'))}
            hint="Users represented in the snapshot"
            icon={Users2}
          />
          <SettingsMetricCard
            label="Workspaces"
            value={String(metricNumber(reflection?.metrics, 'uniqueWorkspaces'))}
            hint="Workspaces touched by runs"
            icon={BarChart3}
          />
          <SettingsMetricCard
            label="Interrupts"
            value={String(metricNumber(reflection?.metrics, 'interruptedRuns'))}
            hint="Runs that needed clarification or approval"
            icon={Activity}
          />
        </div>
      </div>
    </SettingsShell>
  );
}
