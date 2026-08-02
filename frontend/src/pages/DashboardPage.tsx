import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import {
  Activity,
  ArrowRight,
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
        { label: 'Total skills', value, hint, pulse: loading },
        { label: 'Users with messages (24h)', value, hint, pulse: loading },
        { label: 'Langfuse observations (7d)', value, hint, pulse: loading },
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
        pulse: false,
      },
      {
        label: 'Users with messages (24h)',
        value: String(users.messaged24h),
        hint: `${users.total} registered total`,
        pulse: false,
      },
      {
        label: 'Langfuse observations (7d)',
        value: thirdValue,
        hint: thirdHint,
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
          <Banner
            status="warning"
            title="Dashboard data could not be loaded"
            description={loadError}
            endContent={(
              <Button label="Retry" variant="secondary" isLoading={loading} onClick={retryLoad} />
            )}
          />
        ) : null}

        <SettingsSurface className="space-y-6">
          <SettingsSectionHeader
            eyebrow="Snapshot"
            title="Key workspace signals"
            description="Adoption, chat activity, and Langfuse-backed run volume at a glance."
          />

          <SettingsMetricsGrid className="md:grid-cols-3">
            {stats.map(({ label, value, hint, pulse }) => (
              <div key={label} className={pulse ? 'animate-pulse' : undefined}>
                <SettingsMetricCard label={label} value={value} hint={hint} />
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
              {focusAreas.map(({ title, description, to, action }) => (
                <Card key={title} padding={4} variant="muted">
                  <p className="text-sm font-semibold text-slate-900">{title}</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
                  <Link
                    to={to}
                    className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-blue-600 transition hover:text-blue-700"
                  >
                    {action}
                    <ArrowRight size={15} />
                  </Link>
                </Card>
              ))}
            </div>
          </div>
        </SettingsSurface>

        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Activity"
            title="Recent activity"
            description="In-app messages and Langfuse traces when the API is reachable."
            actions={data?.langfuse.publicUrl ? (
              <Button
                label="Open Langfuse"
                variant="secondary"
                href={data.langfuse.publicUrl}
                target="_blank"
                rel="noreferrer"
              />
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
              return (
                <Card key={a.id} padding={4} variant="muted">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{a.title}</p>
                    <p className="text-xs text-slate-500">
                      {rel ? `${rel} · ` : ''}
                      {a.meta}
                    </p>
                  </div>
                </Card>
              );
            })}
          </div>
        </SettingsSurface>

      </div>
    </SettingsShell>
  );
};

export default DashboardPage;
