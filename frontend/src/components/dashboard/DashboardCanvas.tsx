import { useCallback, useEffect, useMemo, useState } from 'react';
import PlotlyChart from '../PlotlyChart';
import type { PlotlySpec } from '../PlotlyChart';
import { getWorkspaceFilePreview } from '../../services/fileApi';
import {
  applyDashboardFilters,
  buildPlotlyPayload,
  type ChartRuntimeDef,
  type DashboardFilterDef,
  type DashboardRow,
  type DatasetSchemaColumn,
  type FilterValues,
} from '@helpudoc/shared/dashboard';
import DashboardFilters from './DashboardFilters';

function normalizePath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

type DashboardSpec = {
  title?: string;
  filters?: DashboardFilterDef[];
  chartRuntimeDefs?: ChartRuntimeDef[];
  datasetSchema?: DatasetSchemaColumn[];
  dataset?: {
    path?: string;
    previewPath?: string;
    rowCount?: number;
  };
};

type Props = {
  workspaceId: string;
  dashboardPath: string;
  onDownloadHtmlExport?: () => void;
};

const DashboardCanvas = ({ workspaceId, dashboardPath, onDownloadHtmlExport }: Props) => {
  const base = normalizePath(dashboardPath);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [filterValues, setFilterValues] = useState<FilterValues>({});

  const load = useCallback(async () => {
    setLoadError(null);
    setSpec(null);
    setRows([]);
    try {
      const specPath = `${base}/dashboard.spec.json`;
      const specPreview = await getWorkspaceFilePreview(workspaceId, specPath);
      const specText = typeof specPreview?.content === 'string' ? specPreview.content : '';
      if (!specText.trim()) {
        setLoadError('Dashboard spec is empty or missing.');
        return;
      }
      const parsed = JSON.parse(specText) as DashboardSpec;
      setSpec(parsed);

      const previewPath =
        typeof parsed.dataset?.previewPath === 'string' && parsed.dataset.previewPath.trim()
          ? normalizePath(parsed.dataset.previewPath)
          : `${base}/data/dashboard.rows.json`;

      const rowsPreview = await getWorkspaceFilePreview(workspaceId, previewPath);
      const rowsText = typeof rowsPreview?.content === 'string' ? rowsPreview.content : '';
      if (!rowsText.trim()) {
        setLoadError('Dashboard preview rows are missing. Regenerate the dashboard package.');
        return;
      }
      const rowsPayload = JSON.parse(rowsText) as { rows?: DashboardRow[] } | DashboardRow[];
      const list = Array.isArray(rowsPayload) ? rowsPayload : rowsPayload.rows;
      if (!Array.isArray(list)) {
        setLoadError('dashboard.rows.json must contain a "rows" array.');
        return;
      }
      setRows(list);
    } catch (e) {
      console.error(e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load dashboard.');
    }
  }, [base, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const schema = spec?.datasetSchema && spec.datasetSchema.length ? spec.datasetSchema : inferSchemaFromRows(rows);
  const filters = (spec?.filters || []) as DashboardFilterDef[];
  const chartDefs = (spec?.chartRuntimeDefs || []) as ChartRuntimeDef[];

  const filteredRows = useMemo(
    () => applyDashboardFilters(rows, filters, filterValues, schema),
    [filterValues, filters, rows, schema],
  );

  const chartSpecs = useMemo(() => {
    return chartDefs.map((def, idx) => {
      const payload = buildPlotlyPayload(filteredRows, def);
      const specChart: PlotlySpec = {
        data: payload.data as PlotlySpec['data'],
        layout: {
          ...payload.layout,
          autosize: true,
        },
        config: payload.config as PlotlySpec['config'],
      };
      return { key: def.chartId || `chart-${def.chartIndex ?? idx}`, title: def.title || `Chart ${idx + 1}`, specChart };
    });
  }, [chartDefs, filteredRows]);

  const title = spec?.title || base.split('/').filter(Boolean).pop() || 'Dashboard';

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white px-6 text-center">
        <p className="text-sm font-medium text-slate-800">Could not open dashboard</p>
        <p className="text-xs text-slate-500">{loadError}</p>
        <button
          type="button"
          className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!spec && !loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-sm text-slate-500">
        Loading dashboard…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500">
              {filteredRows.length} of {rows.length} rows after filters
              {typeof spec?.dataset?.rowCount === 'number' ? ` · package rowCount ${spec.dataset.rowCount}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {onDownloadHtmlExport ? (
              <button
                type="button"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={onDownloadHtmlExport}
              >
                Download HTML export
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => void load()}
            >
              Reload data
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          <DashboardFilters
            filters={filters}
            datasetSchema={schema}
            allRows={rows}
            values={filterValues}
            onChange={setFilterValues}
          />
          {chartSpecs.length === 0 ? (
            <p className="text-sm text-slate-500">No interactive charts in this dashboard spec.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {chartSpecs.map((c) => (
                <article
                  key={c.key}
                  className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
                >
                  <h3 className="mb-2 text-sm font-semibold text-slate-800">{c.title}</h3>
                  <PlotlyChart spec={c.specChart} minHeight={320} className="w-full" />
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function inferSchemaFromRows(sample: DashboardRow[]): DatasetSchemaColumn[] {
  if (!sample.length) return [];
  const row = sample[0];
  return Object.keys(row).map((name) => {
    const v = row[name];
    let t = 'object';
    if (typeof v === 'number') t = 'float64';
    else if (typeof v === 'boolean') t = 'bool';
    else if (typeof v === 'string') t = 'string';
    return { name, type: t };
  });
}

export default DashboardCanvas;
