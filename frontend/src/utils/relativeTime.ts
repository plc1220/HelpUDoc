/**
 * Short "how long ago" label for activity rows. Falls back to an absolute date
 * past a week, because "23d ago" stops being easier to read than the date.
 */
export const formatRelativeTime = (iso: string): string => {
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
};
