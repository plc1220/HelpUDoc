import type { ChartRuntimeDef, DashboardRow } from './types';

function normText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseNumericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isDateLike(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return true;
  return Number.isFinite(Date.parse(trimmed)) && /[/-]/.test(trimmed);
}

function toDateBucket(value: unknown, grain: string): unknown {
  if (!isDateLike(value)) return value;
  const raw = value instanceof Date ? value.toISOString() : String(value).trim();
  const day = /^\d{4}-\d{2}-\d{2}/.test(raw)
    ? raw.slice(0, 10)
    : new Date(raw).toISOString().slice(0, 10);

  if (grain === 'raw') return value;
  if (grain === 'month') return day.slice(0, 7);
  if (grain === 'week') {
    const date = new Date(`${day}T00:00:00Z`);
    const dayOfWeek = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - dayOfWeek + 1);
    return date.toISOString().slice(0, 10);
  }
  return day;
}

function isTimeSeriesChart(chartDef: ChartRuntimeDef): boolean {
  const chartType = normText(chartDef.chartType || 'bar').toLowerCase();
  return chartType === 'line' || chartType === 'area' || chartType === 'scatter';
}

type AggBucket = {
  x: unknown;
  series: unknown;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  values: number[];
  numeratorSum: number;
  denominatorSum: number;
};

export function aggregateChartRows(rows: DashboardRow[], chartDef: ChartRuntimeDef): { x: unknown; y: number; series: unknown }[] {
  const dimensionField = normText(chartDef.dimensionField || chartDef.xField);
  const metricField = normText(chartDef.metricField || chartDef.yField);
  const numeratorField = normText(chartDef.numeratorField);
  const denominatorField = normText(chartDef.denominatorField);
  const seriesField = normText(chartDef.seriesField);
  const chartType = normText(chartDef.chartType || 'bar').toLowerCase();
  const timeGrain = normText(chartDef.timeGrain || 'day').toLowerCase();
  const shouldBucketTime = isTimeSeriesChart(chartDef) && timeGrain !== 'raw';
  const buckets = new Map<string, AggBucket>();

  for (const row of rows) {
    const rawXValue = dimensionField ? row[dimensionField] : '__all__';
    const xValue = shouldBucketTime ? toDateBucket(rawXValue, timeGrain) : rawXValue;
    const seriesValue = seriesField ? row[seriesField] : '__single__';
    const key = `${JSON.stringify(xValue)}::${JSON.stringify(seriesValue)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        x: xValue,
        series: seriesValue,
        count: 0,
        sum: 0,
        min: null,
        max: null,
        values: [],
        numeratorSum: 0,
        denominatorSum: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const metricValue = metricField ? parseNumericValue(row[metricField]) : null;
    const numeratorValue = numeratorField ? parseNumericValue(row[numeratorField]) : null;
    const denominatorValue = denominatorField ? parseNumericValue(row[denominatorField]) : null;
    if (metricValue !== null) {
      bucket.sum += metricValue;
      bucket.min = bucket.min === null ? metricValue : Math.min(bucket.min, metricValue);
      bucket.max = bucket.max === null ? metricValue : Math.max(bucket.max, metricValue);
      bucket.values.push(metricValue);
    }
    if (numeratorValue !== null) bucket.numeratorSum += numeratorValue;
    if (denominatorValue !== null) bucket.denominatorSum += denominatorValue;
  }

  const aggregation = normText(chartDef.aggregation || 'count').toLowerCase();
  const points: { x: unknown; y: number; series: unknown }[] = [];
  for (const bucket of buckets.values()) {
    let yValue: number;
    if (aggregation === 'sum') {
      yValue = bucket.sum;
    } else if (aggregation === 'avg' || aggregation === 'mean') {
      yValue = bucket.values.length ? bucket.sum / bucket.values.length : 0;
    } else if (aggregation === 'min') {
      yValue = bucket.min === null ? 0 : bucket.min;
    } else if (aggregation === 'max') {
      yValue = bucket.max === null ? 0 : bucket.max;
    } else if (aggregation === 'nunique' || aggregation === 'count_distinct') {
      yValue = new Set(bucket.values).size;
    } else if (aggregation === 'ratio' || aggregation === 'rate') {
      yValue = bucket.denominatorSum ? bucket.numeratorSum / bucket.denominatorSum : 0;
    } else {
      yValue = bucket.count;
    }
    points.push({ x: bucket.x, y: yValue, series: bucket.series });
  }

  const hasDateAxis = points.some((point) => isDateLike(point.x));
  const isTemporal = isTimeSeriesChart(chartDef) && hasDateAxis;
  const explicitSortBy = normText(chartDef.sortBy).toLowerCase();
  const sortBy = isTemporal ? 'x' : explicitSortBy || 'y';
  const sortDirection = isTemporal ? 'asc' : normText(chartDef.sortDirection || 'desc').toLowerCase();

  const explicitLimit = chartDef.limit !== undefined && Number(chartDef.limit) > 0;
  const shouldDefaultLimit =
    chartType === 'bar' &&
    !explicitLimit &&
    new Set(points.map((point) => normText(point.x))).size > 30;
  if (shouldDefaultLimit) {
    const totals = new Map<string, { x: unknown; total: number }>();
    for (const point of points) {
      const key = normText(point.x);
      const current = totals.get(key) || { x: point.x, total: 0 };
      current.total += Number(point.y) || 0;
      totals.set(key, current);
    }
    const keep = new Set(
      [...totals.values()]
        .sort((a, b) => b.total - a.total)
        .slice(0, 30)
        .map((item) => normText(item.x)),
    );
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (!keep.has(normText(points[index].x))) points.splice(index, 1);
    }
  }

  points.sort((a, b) => {
    let cmp: number;
    if (sortBy === 'x') {
      const ax = a.x;
      const bx = b.x;
      if (typeof ax === 'number' && typeof bx === 'number') cmp = ax - bx;
      else cmp = normText(ax).localeCompare(normText(bx), undefined, { numeric: true });
    } else {
      cmp = (Number(a.y) || 0) - (Number(b.y) || 0);
    }
    return sortDirection === 'asc' ? cmp : -cmp;
  });

  const limitRaw = chartDef.limit ?? 0;
  const limit = Math.max(0, Number(limitRaw) || 0);
  return limit ? points.slice(0, limit) : points;
}
