/** Process-local Calendar metrics. Labels are fixed enums: never record identities,
 * resource references, request paths, source text, credentials, or error messages. */
export const CALENDAR_PROVIDER_ACTIONS = [
  'calendar_list', 'calendar_get', 'event_list', 'event_get', 'event_create',
  'event_update', 'event_delete', 'watch_create', 'watch_stop', 'drive_search',
  'drive_metadata', 'drive_content', 'drive_export', 'other',
] as const;
export type CalendarProviderAction = typeof CALENDAR_PROVIDER_ACTIONS[number];

export const CALENDAR_UI_SIGNALS = ['ui_open', 'ui_editor_open', 'ui_conflict_resolved', 'ui_brief_requested', 'ui_citation_open', 'ui_commitment_confirmed'] as const;
export const CALENDAR_SIGNALS = [
  ...CALENDAR_UI_SIGNALS,
  'sync_success', 'sync_failure', 'sync_full_resync', 'watch_created', 'watch_renewed',
  'grant_revoked', 'mutation_replayed', 'mutation_conflict', 'mutation_success',
  'mutation_failure', 'brief_started', 'brief_ready', 'brief_failed',
  'agent_read_allowed', 'agent_read_denied', 'agent_write_denied',
  'agent_proposal_created', 'agent_proposal_approved', 'agent_proposal_rejected',
  'watch_hint_accepted', 'watch_hint_rejected',
] as const;
export type CalendarSignal = typeof CALENDAR_SIGNALS[number];

const STATUS_BUCKETS = [
  '1xx', '2xx', '3xx', '400', '401', '403', '404', '409', '410', '412', '422',
  '429', 'other_4xx', '5xx', 'network_error',
] as const;
type StatusBucket = typeof STATUS_BUCKETS[number];
const LATENCY_BOUNDS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 45000, 120000] as const;
const MAX_DURATION_MS = 86_400_000;
const add = (before: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, before + amount);
const validDuration = (value: number) => Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
type Duration = { count: number; sum_ms: number; max_ms: number; buckets: number[] };
const duration = (): Duration => ({ count: 0, sum_ms: 0, max_ms: 0, buckets: Array(LATENCY_BOUNDS_MS.length + 1).fill(0) });
const observe = (histogram: Duration, milliseconds: number) => {
  histogram.count = add(histogram.count);
  histogram.sum_ms = add(histogram.sum_ms, milliseconds);
  histogram.max_ms = Math.max(histogram.max_ms, milliseconds);
  // Buckets are cumulative, matching the usual histogram export convention.
  LATENCY_BOUNDS_MS.forEach((bound, i) => { if (milliseconds <= bound) histogram.buckets[i] = add(histogram.buckets[i]); });
  histogram.buckets[LATENCY_BOUNDS_MS.length] = add(histogram.buckets[LATENCY_BOUNDS_MS.length]);
};
const copyDuration = (value: Duration) => ({
  count: value.count, sum_ms: value.sum_ms, max_ms: value.max_ms,
  buckets: value.buckets.map((count, i) => ({ le_ms: LATENCY_BOUNDS_MS[i] ?? '+Inf', count })),
});

function statusBucket(status: number | 'network_error'): StatusBucket | undefined {
  if (status === 'network_error') return status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const exact = String(status) as StatusBucket;
  if ((STATUS_BUCKETS as readonly string[]).includes(exact)) return exact;
  if (status < 200) return '1xx';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  return status < 500 ? 'other_4xx' : '5xx';
}

/** Classify known adapter operations without retaining a path or any of its IDs. */
export function calendarProviderAction(path: string, method = 'GET', drive = false): CalendarProviderAction {
  const verb = method.toUpperCase();
  const route = path.split('?', 1)[0];
  if (drive) {
    if (route === '/files') return 'drive_search';
    if (/^\/files\/[^/]+\/export$/.test(route)) return 'drive_export';
    if (/^\/files\/[^/]+$/.test(route)) return /(?:\?|&)alt=media(?:&|$)/.test(path) ? 'drive_content' : 'drive_metadata';
    return 'other';
  }
  if (route === '/users/me/calendarList') return 'calendar_list';
  if (/^\/users\/me\/calendarList\/[^/]+$/.test(route)) return 'calendar_get';
  if (route === '/channels/stop') return 'watch_stop';
  if (/^\/calendars\/[^/]+\/events\/watch$/.test(route)) return 'watch_create';
  if (/^\/calendars\/[^/]+\/events$/.test(route)) return verb === 'POST' ? 'event_create' : verb === 'GET' ? 'event_list' : 'other';
  if (/^\/calendars\/[^/]+\/events\/[^/]+$/.test(route)) {
    if (verb === 'GET') return 'event_get';
    if (verb === 'PATCH' || verb === 'PUT') return 'event_update';
    if (verb === 'DELETE') return 'event_delete';
  }
  return 'other';
}

export type CalendarSyncHealth = {
  sources: number; pending: number; stale: number; reauth: number; maxCursorAgeMs: number;
};

/** Bounded aggregate snapshot, suitable for an authenticated operator endpoint.
 * Histograms describe provider attempts, not end-to-end UI SLOs. Counters reset
 * on process restart and require a collector to aggregate multiple replicas. */
export class CalendarTelemetry {
  private readonly startedAt: number;
  private readonly providers = new Map<CalendarProviderAction, { attempts: number; statuses: Record<StatusBucket, number>; latency: Duration }>();
  private readonly signals = new Map<CalendarSignal, { count: number; latency: Duration }>();
  private health?: CalendarSyncHealth & { collected_at: string };
  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); }

  recordProvider(input: { action: CalendarProviderAction; status: number | 'network_error'; durationMs: number }): boolean {
    const bucket = statusBucket(input.status);
    if (!(CALENDAR_PROVIDER_ACTIONS as readonly string[]).includes(input.action) || !bucket || !validDuration(input.durationMs)) return false;
    let entry = this.providers.get(input.action);
    if (!entry) {
      entry = { attempts: 0, statuses: Object.fromEntries(STATUS_BUCKETS.map(key => [key, 0])) as Record<StatusBucket, number>, latency: duration() };
      this.providers.set(input.action, entry);
    }
    entry.attempts = add(entry.attempts); entry.statuses[bucket] = add(entry.statuses[bucket]); observe(entry.latency, input.durationMs);
    return true;
  }

  recordSignal(name: CalendarSignal, durationMs?: number): boolean {
    if (!(CALENDAR_SIGNALS as readonly string[]).includes(name) || durationMs !== undefined && !validDuration(durationMs)) return false;
    let entry = this.signals.get(name);
    if (!entry) { entry = { count: 0, latency: duration() }; this.signals.set(name, entry); }
    entry.count = add(entry.count);
    if (durationMs !== undefined) observe(entry.latency, durationMs);
    return true;
  }

  recordSyncHealth(input: CalendarSyncHealth): boolean {
    const counts = [input.sources, input.pending, input.stale, input.reauth];
    if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || input.pending + input.stale + input.reauth > input.sources || !Number.isFinite(input.maxCursorAgeMs) || input.maxCursorAgeMs < 0 || input.maxCursorAgeMs > Number.MAX_SAFE_INTEGER) return false;
    // Copy only the explicit aggregate fields; never spread caller-supplied data.
    this.health = { sources: input.sources, pending: input.pending, stale: input.stale, reauth: input.reauth, maxCursorAgeMs: input.maxCursorAgeMs, collected_at: new Date(this.now()).toISOString() };
    return true;
  }

  snapshot() {
    return {
      schema_version: 1, scope: 'process_lifetime', started_at: new Date(this.startedAt).toISOString(), collected_at: new Date(this.now()).toISOString(),
      provider: CALENDAR_PROVIDER_ACTIONS.flatMap(action => {
        const entry = this.providers.get(action);
        return entry ? [{ action, attempts: entry.attempts, statuses: { ...entry.statuses }, latency_ms: copyDuration(entry.latency) }] : [];
      }),
      signals: CALENDAR_SIGNALS.flatMap(name => {
        const entry = this.signals.get(name);
        return entry ? [{ name, count: entry.count, latency_ms: copyDuration(entry.latency) }] : [];
      }),
      sync_health: this.health ? { ...this.health } : null,
    };
  }
}

export const calendarTelemetry = new CalendarTelemetry();
