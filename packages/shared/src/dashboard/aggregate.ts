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
  const buckets = new Map<string, AggBucket>();

  for (const row of rows) {
    const xValue = dimensionField ? row[dimensionField] : '__all__';
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

  const sortBy = normText(chartDef.sortBy || 'y').toLowerCase();
  const sortDirection = normText(chartDef.sortDirection || 'desc').toLowerCase();
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
