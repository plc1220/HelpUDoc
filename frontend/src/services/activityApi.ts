import { apiFetch, API_URL } from './apiClient';

export type ActivityScope =
  | { kind: 'platform' }
  | { kind: 'teams'; teamNames: string[] };

export type ActivityItem = {
  id: string;
  at: string;
  actorName: string;
  action: string;
  title: string;
  meta: string;
};

export type ActivityFeed = {
  scope: ActivityScope;
  items: ActivityItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Pass back as `before` so later pages read the same stable result set. */
  anchor: string;
  /** Oldest instant the feed reaches. */
  since: string;
};

export type UserCapabilities = {
  canViewActivity: boolean;
  activityScope: 'platform' | 'teams' | null;
};

/**
 * The feed is scoped by the server from the session identity. There is no scope
 * argument by design — the client never asks for a scope and cannot widen one.
 */
export async function fetchRecentActivity(
  options: { page?: number; before?: string } = {},
): Promise<ActivityFeed> {
  const params = new URLSearchParams();
  if (options.page && options.page > 1) {
    params.set('page', String(options.page));
  }
  // Carrying the anchor forward is what stops page 2 repeating a row when a new
  // event lands between requests.
  if (options.before) {
    params.set('before', options.before);
  }
  const query = params.toString();
  const response = await apiFetch(`${API_URL}/activity${query ? `?${query}` : ''}`);
  if (response.status === 403) {
    throw new Error('Activity is available to team leads and administrators.');
  }
  if (!response.ok) {
    throw new Error('Failed to load activity');
  }
  return response.json();
}

/** Used only to hide a control the caller cannot use. Never to grant anything. */
export async function fetchCapabilities(): Promise<UserCapabilities> {
  const response = await apiFetch(`${API_URL}/me/capabilities`);
  if (!response.ok) {
    throw new Error('Failed to load capabilities');
  }
  return response.json();
}
