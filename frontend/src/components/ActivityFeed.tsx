import { Card } from '@astryxdesign/core/Card';
import { Activity } from 'lucide-react';
import { SettingsEmptyState } from '../features/settings/components/SettingsScaffold';
import type { ActivityItem } from '../services/activityApi';
import { formatRelativeTime } from '../utils/relativeTime';


type ActivityFeedProps = {
  items: ActivityItem[];
  loading: boolean;
  emptyDescription?: string;
};

const ActivityFeed = ({ items, loading, emptyDescription }: ActivityFeedProps) => {
  if (loading && items.length === 0) {
    return <p className="text-sm text-slate-500">Loading recent activity…</p>;
  }

  if (!loading && items.length === 0) {
    return (
      <SettingsEmptyState
        title="No recent activity yet"
        description={emptyDescription || 'Actions on workspaces and files will appear here.'}
        icon={Activity}
      />
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const relative = formatRelativeTime(item.at);
        return (
          <Card key={item.id} padding={4} variant="muted">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{item.title}</p>
              <p className="text-xs text-slate-500">
                {item.actorName}
                {relative ? ` · ${relative}` : ''}
                {item.meta ? ` · ${item.meta}` : ''}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
};

export default ActivityFeed;
