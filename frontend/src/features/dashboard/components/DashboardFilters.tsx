import { useMemo } from 'react';
import {
  distinctFieldValues,
  inferFieldType,
  type DashboardFilterDef,
  type DashboardRow,
  type DatasetSchemaColumn,
  type FilterValues,
} from '@helpudoc/dashboard-runtime';

type Props = {
  filters: DashboardFilterDef[];
  datasetSchema: DatasetSchemaColumn[];
  allRows: DashboardRow[];
  values: FilterValues;
  onChange: (next: FilterValues) => void;
};

const DashboardFilters = ({ filters, datasetSchema, allRows, values, onChange }: Props) => {
  const controls = useMemo(() => {
    if (!filters.length) {
      return null;
    }
    return filters.map((def) => {
      const id = String(def.id || def.field).trim();
      const field = String(def.field || '').trim();
      const label = String(def.label || field).trim() || field;
      const ftype = inferFieldType(def, datasetSchema);
      const current = values[id];

      if (ftype === 'categorical') {
        const options = distinctFieldValues(allRows, field);
        const selected = Array.isArray(current) ? String(current[0] || '') : current ? String(current) : '';
        return (
          <label key={id} className="flex min-w-[200px] flex-col gap-1 text-xs text-slate-600">
            <span className="font-semibold text-slate-800">{label}</span>
            <select
              className="h-9 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
              value={selected}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value) {
                  next[id] = e.target.value;
                } else {
                  delete next[id];
                }
                onChange(next);
              }}
            >
              <option value="">All {label}</option>
              {options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        );
      }

      if (ftype === 'date') {
        const payload =
          current && typeof current === 'object' && !Array.isArray(current)
            ? (current as Record<string, unknown>)
            : {};
        const start = typeof payload.start === 'string' ? payload.start : '';
        const end = typeof payload.end === 'string' ? payload.end : '';
        return (
          <div key={id} className="flex min-w-[220px] flex-col gap-1 text-xs text-slate-600">
            <span className="font-semibold text-slate-800">{label}</span>
            <div className="flex flex-wrap gap-2">
              <input
                type="date"
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={start.slice(0, 10)}
                onChange={(e) =>
                  onChange({
                    ...values,
                    [id]: { ...payload, start: e.target.value ? `${e.target.value}T00:00:00` : '' },
                  })
                }
              />
              <input
                type="date"
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={end.slice(0, 10)}
                onChange={(e) =>
                  onChange({
                    ...values,
                    [id]: { ...payload, end: e.target.value ? `${e.target.value}T23:59:59` : '' },
                  })
                }
              />
            </div>
          </div>
        );
      }

      const payload =
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      const min = payload.min !== undefined && payload.min !== '' ? String(payload.min) : '';
      const max = payload.max !== undefined && payload.max !== '' ? String(payload.max) : '';
      return (
        <div key={id} className="flex min-w-[200px] flex-col gap-1 text-xs text-slate-600">
          <span className="font-semibold text-slate-800">{label}</span>
          <div className="flex flex-wrap gap-2">
            <input
              type="number"
              placeholder="Min"
              className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={min}
              onChange={(e) =>
                onChange({
                  ...values,
                  [id]: { ...payload, min: e.target.value === '' ? '' : Number(e.target.value) },
                })
              }
            />
            <input
              type="number"
              placeholder="Max"
              className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={max}
              onChange={(e) =>
                onChange({
                  ...values,
                  [id]: { ...payload, max: e.target.value === '' ? '' : Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
      );
    });
  }, [allRows, datasetSchema, filters, onChange, values]);

  if (!filters.length) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">Filters</span>
        <button
          type="button"
          className="text-xs font-medium text-slate-600 underline decoration-slate-400 underline-offset-2 hover:text-slate-900"
          onClick={() => onChange({})}
        >
          Reset filters
        </button>
      </div>
      <div className="flex flex-wrap gap-4">{controls}</div>
    </div>
  );
};

export default DashboardFilters;
