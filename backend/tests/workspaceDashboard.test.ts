import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusAreas } from '../src/services/workspaceOverviewService';
import { fetchLangfuseAggregates, isLangfuseConfigured } from '../src/services/langfuseClient';

test('buildFocusAreas suggests seeding skills when registry is empty', () => {
  const f = buildFocusAreas({
    skillCount: 0,
    totalUsers: 5,
    messaged24h: 2,
    langfuseConfigured: false,
    langfuseAvailable: false,
  });
  assert.ok(f.some((x) => x.title.includes('Seed') || x.title.toLowerCase().includes('skill')));
});

test('buildFocusAreas flags adoption when many users are quiet', () => {
  const f = buildFocusAreas({
    skillCount: 3,
    totalUsers: 5,
    messaged24h: 1,
    langfuseConfigured: true,
    langfuseAvailable: true,
  });
  assert.ok(
    f.some((x) => x.title.toLowerCase().includes('adoption') || x.to === '/settings/users'),
  );
});

test('buildFocusAreas warns when Langfuse is configured but unavailable', () => {
  const f = buildFocusAreas({
    skillCount: 2,
    totalUsers: 2,
    messaged24h: 2,
    langfuseConfigured: true,
    langfuseAvailable: false,
  });
  assert.ok(f.some((x) => x.title.toLowerCase().includes('langfuse')));
});

test('fetchLangfuseAggregates parses daily metrics and lists traces (mocked fetch)', async () => {
  const prev = {
    base: process.env.LANGFUSE_BASE_URL,
    pk: process.env.LANGFUSE_PUBLIC_KEY,
    sk: process.env.LANGFUSE_SECRET_KEY,
    next: process.env.LANGFUSE_NEXTAUTH_URL,
    fetch: globalThis.fetch,
  };
  process.env.LANGFUSE_BASE_URL = 'http://langfuse.test';
  process.env.LANGFUSE_PUBLIC_KEY = 'lf_pk';
  process.env.LANGFUSE_SECRET_KEY = 'lf_sk';
  process.env.LANGFUSE_NEXTAUTH_URL = 'https://langfuse.example';
  assert.equal(isLangfuseConfigured(), true);

  (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (url: string) => {
    if (url.includes('/api/public/metrics/daily')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ countTraces: 3, countObservations: 7 }] }),
      } as unknown as Response;
    }
    if (url.includes('/api/public/traces')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'a', name: 'Test trace', timestamp: '2024-01-01T00:00:00.000Z' },
          ],
        }),
      } as unknown as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  const out = await fetchLangfuseAggregates('2024-01-01T00:00:00.000Z', '2024-01-08T00:00:00.000Z');
  assert.equal(out.available, true);
  assert.equal(out.traces7d, 3);
  assert.equal(out.observations7d, 7);
  assert.equal(out.recentTraces.length, 1);
  assert.equal(out.recentTraces[0]?.id, 'a');

  if (prev.base === undefined) delete process.env.LANGFUSE_BASE_URL; else process.env.LANGFUSE_BASE_URL = prev.base;
  if (prev.pk === undefined) delete process.env.LANGFUSE_PUBLIC_KEY; else process.env.LANGFUSE_PUBLIC_KEY = prev.pk;
  if (prev.sk === undefined) delete process.env.LANGFUSE_SECRET_KEY; else process.env.LANGFUSE_SECRET_KEY = prev.sk;
  if (prev.next === undefined) delete process.env.LANGFUSE_NEXTAUTH_URL; else process.env.LANGFUSE_NEXTAUTH_URL = prev.next;
  globalThis.fetch = prev.fetch;
});

test('fetchLangfuseAggregates sends metrics query payload when daily metrics 404', async () => {
  const prev = {
    base: process.env.LANGFUSE_BASE_URL,
    pk: process.env.LANGFUSE_PUBLIC_KEY,
    sk: process.env.LANGFUSE_SECRET_KEY,
    next: process.env.LANGFUSE_NEXTAUTH_URL,
    fetch: globalThis.fetch,
  };
  process.env.LANGFUSE_BASE_URL = 'http://langfuse.test';
  process.env.LANGFUSE_PUBLIC_KEY = 'lf_pk';
  process.env.LANGFUSE_SECRET_KEY = 'lf_sk';
  process.env.LANGFUSE_NEXTAUTH_URL = 'https://langfuse.example';

  const metricViews: string[] = [];
  (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/public/metrics/daily') {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    if (parsed.pathname === '/api/public/metrics') {
      const query = JSON.parse(parsed.searchParams.get('query') || '{}') as {
        view?: string;
        metrics?: Array<{ measure?: string; aggregation?: string }>;
        fromTimestamp?: string;
        toTimestamp?: string;
      };
      assert.equal(query.metrics?.[0]?.measure, 'count');
      assert.equal(query.metrics?.[0]?.aggregation, 'count');
      assert.equal(query.fromTimestamp, '2024-01-01T00:00:00.000Z');
      assert.equal(query.toTimestamp, '2024-01-08T00:00:00.000Z');
      metricViews.push(query.view || '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ count_count: query.view === 'traces' ? '4' : '9' }] }),
      } as unknown as Response;
    }
    if (parsed.pathname === '/api/public/traces') {
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  const out = await fetchLangfuseAggregates('2024-01-01T00:00:00.000Z', '2024-01-08T00:00:00.000Z');
  assert.deepEqual(metricViews, ['traces', 'observations']);
  assert.equal(out.available, true);
  assert.equal(out.traces7d, 4);
  assert.equal(out.observations7d, 9);

  if (prev.base === undefined) delete process.env.LANGFUSE_BASE_URL; else process.env.LANGFUSE_BASE_URL = prev.base;
  if (prev.pk === undefined) delete process.env.LANGFUSE_PUBLIC_KEY; else process.env.LANGFUSE_PUBLIC_KEY = prev.pk;
  if (prev.sk === undefined) delete process.env.LANGFUSE_SECRET_KEY; else process.env.LANGFUSE_SECRET_KEY = prev.sk;
  if (prev.next === undefined) delete process.env.LANGFUSE_NEXTAUTH_URL; else process.env.LANGFUSE_NEXTAUTH_URL = prev.next;
  globalThis.fetch = prev.fetch;
});
