import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import SettingsShell from '../components/settings/SettingsShell';
import { SettingsSectionHeader, SettingsSurface } from '../components/settings/SettingsScaffold';
import ActivityFeed from '../components/ActivityFeed';
import { fetchRecentActivity, type ActivityFeed as ActivityFeedData } from '../services/activityApi';

const describeScope = (feed: ActivityFeedData | null): string => {
  if (!feed) return 'Recent actions on workspaces and files.';
  if (feed.scope.kind === 'platform') {
    return 'Recent actions across every user on the platform.';
  }
  const names = feed.scope.teamNames;
  if (!names.length) {
    return 'Recent actions in the workspaces your teams own.';
  }
  // Naming the teams matters: without it a lead cannot tell a quiet week from a
  // scope that is narrower than they expected.
  return `Recent actions in workspaces owned by ${names.join(', ')}.`;
};

const ActivityPage = () => {
  const [feed, setFeed] = useState<ActivityFeedData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  // Held across pages so every request reads the same stable result set. Cleared
  // only by Refresh, which is the deliberate way to pick up newer events.
  const anchorRef = useRef<string | null>(null);

  const load = useCallback(async (targetPage: number, isCancelled?: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchRecentActivity({
        page: targetPage,
        before: anchorRef.current || undefined,
      });
      if (!isCancelled?.()) {
        anchorRef.current = next.anchor;
        setFeed(next);
        setPage(next.page);
      }
    } catch (error) {
      if (!isCancelled?.()) {
        setFeed(null);
        setLoadError(error instanceof Error ? error.message : 'Failed to load activity');
      }
    } finally {
      if (!isCancelled?.()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(1, () => cancelled);
    return () => { cancelled = true; };
  }, [load]);

  const refresh = useCallback(() => {
    anchorRef.current = null;
    setPage(1);
    void load(1);
  }, [load]);

  return (
    <SettingsShell
      eyebrow="Oversight"
      title="Activity"
      description="Recorded actions you have visibility into, 20 per page, reaching back one month."
    >
      <div className="space-y-6">
        {loadError ? (
          <Banner
            status="warning"
            title="Activity could not be loaded"
            description={loadError}
            endContent={(
              <Button label="Retry" variant="secondary" isLoading={loading} onClick={refresh} />
            )}
          />
        ) : null}

        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Activity"
            title="Recent activity"
            description={describeScope(feed)}
            actions={(
              <Button label="Refresh" variant="secondary" size="sm" isLoading={loading} onClick={refresh} />
            )}
          />
          <div className="mt-6">
            <ActivityFeed
              items={feed?.items || []}
              loading={loading}
              emptyDescription={page > 1
                ? 'No more activity on this page.'
                : 'Actions on workspaces and files from the past month will appear here.'}
            />
          </div>

          {feed && (feed.hasMore || page > 1) ? (
            <div className="mt-6 flex items-center justify-between gap-4 border-t border-slate-200 pt-4">
              <p className="text-xs text-slate-500">
                Page {page} · showing {feed.items.length} of up to {feed.pageSize}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  label="Previous"
                  variant="secondary"
                  size="sm"
                  isDisabled={page <= 1 || loading}
                  onClick={() => void load(page - 1)}
                />
                <Button
                  label="Next"
                  variant="secondary"
                  size="sm"
                  isDisabled={!feed.hasMore || loading}
                  onClick={() => void load(page + 1)}
                />
              </div>
            </div>
          ) : null}
        </SettingsSurface>
      </div>
    </SettingsShell>
  );
};

export default ActivityPage;
