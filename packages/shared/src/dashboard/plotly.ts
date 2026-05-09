import { aggregateChartRows } from './aggregate';
import type { ChartRuntimeDef, DashboardRow } from './types';

function normText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function buildPlotlyPayload(rows: DashboardRow[], chartDef: ChartRuntimeDef): {
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
} {
  const grouped = aggregateChartRows(rows, chartDef);
  const chartType = normText(chartDef.chartType || 'bar').toLowerCase();
  const dimensionField = normText(chartDef.dimensionField || chartDef.xField);
  const metricField = normText(chartDef.metricField || chartDef.yField || chartDef.aggregation);
  const pointCount = grouped.length;
  const labels = {
    x: normText(chartDef.labels?.x || chartDef.xTitle),
    y: normText(chartDef.labels?.y || chartDef.yTitle),
    title: normText(chartDef.labels?.title || chartDef.title),
  };
  const seriesValues = grouped.map((p) => p.series);
  const uniqueSeries = [...new Map(seriesValues.map((s) => [JSON.stringify(s), s])).values()];

  const traces: Record<string, unknown>[] = [];
  for (const seriesKey of uniqueSeries.length ? uniqueSeries : ['__single__']) {
    const points = grouped.filter((item) => item.series === seriesKey);
    const traceName =
      seriesKey === '__single__' ? labels.title || normText(chartDef.title) : normText(seriesKey);

    if (chartType === 'pie') {
      traces.push({
        type: 'pie',
        name: labels.title || normText(chartDef.title),
        labels: points.map((p) => p.x),
        values: points.map((p) => p.y),
        hole: 0.48,
      });
      break;
    }

    let trace: Record<string, unknown> = {
      type: chartType === 'line' || chartType === 'area' ? 'scatter' : chartType,
      name: traceName,
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
    };

    if (chartType === 'line' || chartType === 'area') {
      const requestedMode = normText(chartDef.mode);
      trace.mode = pointCount > 60
        ? (requestedMode && !requestedMode.includes('markers') ? requestedMode : 'lines')
        : requestedMode || 'lines+markers';
      trace.hovertemplate = `%{x}<br>${traceName}: %{y}<extra></extra>`;
      if (chartType === 'area') trace.fill = 'tozeroy';
    }
    if (chartType === 'scatter') {
      trace.mode = normText(chartDef.mode || 'markers');
      trace.hovertemplate = `%{x}<br>${traceName}: %{y}<extra></extra>`;
    }
    if (chartType === 'bar' && normText(chartDef.orientation).toLowerCase() === 'h') {
      trace = {
        ...trace,
        type: 'bar',
        orientation: 'h',
        x: points.map((p) => p.y),
        y: points.map((p) => p.x),
      };
    }
    traces.push(trace);
  }

  const valueFormat = normText(chartDef.format).toLowerCase();
  let tickformat: string | undefined;
  if (valueFormat === 'percent' || valueFormat === 'percentage' || valueFormat === 'pct') {
    tickformat = '.1%';
  } else if (valueFormat === 'currency' || valueFormat === 'usd') {
    tickformat = '$,.0f';
  }

  const layoutSpan = normText(chartDef.layoutSpan || 'half').toLowerCase();
  const isPie = chartType === 'pie';
  const isHorizontalBar = chartType === 'bar' && normText(chartDef.orientation).toLowerCase() === 'h';
  const categoryValues = [...new Map(grouped.map((point) => [normText(point.x), point.x])).values()];
  const denseCategoryAxis = chartType === 'bar' && categoryValues.length > 12;

  const layout: Record<string, unknown> = {
    title: '',
    template: 'plotly_white',
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 18, r: 24, b: 56, l: 56 },
    height: layoutSpan === 'wide' ? 430 : 360,
    font: { family: 'Avenir Next, Segoe UI, sans-serif', color: '#0f172a' },
    legend: { orientation: 'h', y: -0.18, font: { size: 11 } },
    ...(chartType === 'line' || chartType === 'area' ? { hovermode: 'x unified' } : {}),
  };

  if (!isPie) {
    layout.xaxis = {
      title:
        labels.x ||
        (isHorizontalBar ? metricField : dimensionField),
      gridcolor: '#e2e8f0',
      tickfont: { size: 12, color: '#475569' },
      titlefont: { size: 12, color: '#475569' },
      automargin: true,
      ...(denseCategoryAxis && !isHorizontalBar ? { tickangle: -35 } : {}),
      ...(denseCategoryAxis && !isHorizontalBar
        ? { categoryorder: 'array', categoryarray: categoryValues }
        : {}),
    };
    layout.yaxis = {
      title:
        labels.y ||
        (isHorizontalBar ? dimensionField : metricField),
      gridcolor: '#e2e8f0',
      tickfont: { size: 12, color: '#475569' },
      titlefont: { size: 12, color: '#475569' },
      automargin: true,
      ...(tickformat ? { tickformat } : {}),
    };
  }

  return {
    data: traces,
    layout,
    config: { displayModeBar: false, responsive: true },
  };
}
