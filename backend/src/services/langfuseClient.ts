const USER_AGENT = 'helpudoc-backend/1.0 (workspace-overview)';

export type LangfuseTracesListItem = {
  id: string;
  name?: string | null;
  timestamp?: string | null;
};

type DailyMetricsRow = {
  day?: string;
  date?: string;
  countTraces?: number;
  countObservations?: number;
  totalObservations?: number;
  [key: string]: unknown;
};

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

function basicHeader(publicKey: string, secretKey: string): string {
  const token = Buffer.from(`${publicKey}:${secretKey}`, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

export function isLangfuseConfigured(): boolean {
  const base = (process.env.LANGFUSE_BASE_URL || '').trim();
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  return Boolean(base && publicKey && secretKey);
}

type Fetcher = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function getFetch(): Fetcher {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch as Fetcher;
  }
  throw new Error('global fetch is not available; use Node 18+');
}

export type LangfuseAggregates = {
  available: boolean;
  error?: string;
  publicUrl: string | null;
  toolCalls7d: number;
  traces7d: number;
  observations7d: number;
  recentTraces: LangfuseTracesListItem[];
};

const emptyResult = (publicUrl: string | null): LangfuseAggregates => ({
  available: false,
  publicUrl,
  toolCalls7d: 0,
  traces7d: 0,
  observations7d: 0,
  recentTraces: [],
});

function readPublicUrl(): string | null {
  const u = (process.env.LANGFUSE_NEXTAUTH_URL || '').trim();
  return u || null;
}

function sumDailyMetrics(
  data: unknown,
): { traces: number; observations: number } {
  let traces = 0;
  let observations = 0;
  const rows: DailyMetricsRow[] = Array.isArray((data as { data?: unknown })?.data)
    ? ((data as { data: DailyMetricsRow[] }).data)
    : Array.isArray((data as { metrics?: unknown })?.metrics)
      ? ((data as { metrics: DailyMetricsRow[] }).metrics)
      : Array.isArray(data)
        ? (data as DailyMetricsRow[])
        : [];
  for (const row of rows) {
    const t = row.countTraces;
    const o = row.countObservations ?? row.totalObservations;
    if (typeof t === 'number') traces += t;
    if (typeof o === 'number') observations += o;
  }
  return { traces, observations };
}

function readCountMetric(data: unknown): number {
  const rows: Array<Record<string, unknown>> = Array.isArray((data as { data?: unknown })?.data)
    ? ((data as { data: Array<Record<string, unknown>> }).data)
    : Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : [];

  let total = 0;
  for (const row of rows) {
    const raw = row.count_count ?? row.count;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

function buildMetricsQuery(view: 'traces' | 'observations', fromIso: string, toIso: string): string {
  return JSON.stringify({
    view,
    metrics: [{ measure: 'count', aggregation: 'count' }],
    filters: [],
    fromTimestamp: fromIso,
    toTimestamp: toIso,
  });
}

/**
 * Fetches 7d aggregates and a few recent traces from Langfuse public API (self-hosted v3).
 * Uses legacy daily metrics when present; does not throw on 404/5xx.
 */
export async function fetchLangfuseAggregates(
  fromIso: string,
  toIso: string,
): Promise<LangfuseAggregates> {
  const publicUrl = readPublicUrl();
  if (!isLangfuseConfigured()) {
    return { ...emptyResult(publicUrl), available: false };
  }

  const base = normalizeBaseUrl((process.env.LANGFUSE_BASE_URL || '').trim());
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  const auth = basicHeader(publicKey, secretKey);
  const fetcher = getFetch();
  const commonHeaders = {
    Authorization: auth,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  const dailyUrl = new URL('/api/public/metrics/daily', base);
  dailyUrl.searchParams.set('fromTimestamp', fromIso);
  dailyUrl.searchParams.set('toTimestamp', toIso);

  let dailyJson: unknown;
  let dailyStatus = 0;
  let requestError: string | undefined;
  try {
    const res = await fetcher(dailyUrl.toString(), { method: 'GET', headers: commonHeaders });
    dailyStatus = res.status;
    if (res.ok) {
      dailyJson = await res.json();
    }
  } catch (e) {
    requestError = e instanceof Error ? e.message : String(e);
  }

  let { traces, observations } = sumDailyMetrics(dailyJson);
  if (dailyStatus === 404) {
    try {
      const v2Url = new URL('/api/public/metrics', base);
      v2Url.searchParams.set('query', buildMetricsQuery('traces', fromIso, toIso));
      const traceMetrics = await fetcher(v2Url.toString(), { method: 'GET', headers: commonHeaders });
      if (traceMetrics.ok) {
        traces = readCountMetric(await traceMetrics.json());
      }

      const observationsUrl = new URL('/api/public/metrics', base);
      observationsUrl.searchParams.set('query', buildMetricsQuery('observations', fromIso, toIso));
      const observationMetrics = await fetcher(observationsUrl.toString(), { method: 'GET', headers: commonHeaders });
      if (observationMetrics.ok) {
        observations = readCountMetric(await observationMetrics.json());
      }
    } catch {
      // ignore
    }
  }

  const recent: LangfuseTracesListItem[] = [];
  let traceStatus = 0;
  try {
    const tracesUrl = new URL('/api/public/traces', base);
    tracesUrl.searchParams.set('limit', '5');
    tracesUrl.searchParams.set('page', '1');
    const tRes = await fetcher(tracesUrl.toString(), { method: 'GET', headers: commonHeaders });
    traceStatus = tRes.status;
    if (tRes.ok) {
      const body = (await tRes.json()) as { data?: Array<Record<string, unknown>> };
      const list = body?.data;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const id = typeof item.id === 'string' ? item.id : String(item.id ?? '');
          if (!id) continue;
          recent.push({
            id,
            name: (item.name as string) || null,
            timestamp: (item.timestamp as string) || (item.startTime as string) || null,
          });
        }
      }
    }
  } catch {
    // keep recent empty
  }

  const connected = dailyStatus === 200 || traceStatus === 200;

  return {
    available: connected,
    error: requestError,
    publicUrl,
    toolCalls7d: observations,
    traces7d: traces,
    observations7d: observations,
    recentTraces: recent,
  };
}
