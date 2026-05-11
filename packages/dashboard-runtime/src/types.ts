export type DashboardRow = Record<string, unknown>;

export type DatasetSchemaColumn = { name: string; type: string };

export type DashboardFilterDef = {
  id: string;
  field: string;
  type: string;
  label?: string;
  multi?: boolean;
};

/** Executable chart instructions emitted by the agent (dashboard.spec.json chartRuntimeDefs). */
export type ChartRuntimeDef = {
  chartId?: string;
  chartIndex?: number;
  chartType?: string;
  dimensionField?: string;
  metricField?: string;
  numeratorField?: string;
  denominatorField?: string;
  xField?: string;
  yField?: string;
  seriesField?: string;
  aggregation?: string;
  orientation?: string;
  sortBy?: string;
  sortDirection?: string;
  timeGrain?: 'day' | 'week' | 'month' | string;
  limit?: number;
  mode?: string;
  xTitle?: string;
  yTitle?: string;
  title?: string;
  format?: string;
  layoutSpan?: string;
  labels?: { x?: string; y?: string; title?: string };
};

export type FilterValues = Record<string, unknown>;
