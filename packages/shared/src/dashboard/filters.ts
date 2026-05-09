import type { DashboardFilterDef, DashboardRow, DatasetSchemaColumn, FilterValues } from './types';

function normText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function schemaTypeMap(schema: DatasetSchemaColumn[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const col of schema) {
    const name = normText(col.name).trim();
    if (name) m[name] = normText(col.type).toLowerCase();
  }
  return m;
}

export function inferFieldType(filterDef: DashboardFilterDef, datasetSchema: DatasetSchemaColumn[]): string {
  const declared = normText(filterDef.type).toLowerCase();
  if (declared === 'numeric' || declared === 'date' || declared === 'datetime') {
    return declared === 'datetime' ? 'date' : declared;
  }
  const field = normText(filterDef.field).trim();
  const raw = schemaTypeMap(datasetSchema)[field] || '';
  if (raw.includes('date') || raw.includes('time')) return 'date';
  if (/(int|float|double|decimal|real|numeric)/.test(raw)) return 'numeric';
  return 'categorical';
}

function parseDateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(String(value).replace('Z', '+00:00'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNumericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeComparable(value: unknown, fieldType: string): number | string | null {
  if (fieldType === 'date') {
    const d = parseDateValue(value);
    return d ? d.getTime() / 1000 : null;
  }
  if (fieldType === 'numeric') {
    return parseNumericValue(value);
  }
  return normText(value);
}

function rowMatchesFilter(
  row: DashboardRow,
  filterDef: DashboardFilterDef,
  filterValue: unknown,
  datasetSchema: DatasetSchemaColumn[],
): boolean {
  const field = normText(filterDef.field).trim();
  const fieldType = inferFieldType(filterDef, datasetSchema);
  const rowValue = row[field];

  if (fieldType === 'categorical') {
    const values = Array.isArray(filterValue)
      ? filterValue.map((v) => normText(v))
      : filterValue === null || filterValue === undefined || filterValue === ''
        ? []
        : [normText(filterValue)];
    if (values.length === 0) return true;
    const set = new Set(values);
    return set.has(normText(rowValue));
  }

  if (fieldType === 'date') {
    const rowTime = normalizeComparable(rowValue, 'date');
    if (rowTime === null) return false;
    const payload =
      filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue)
        ? (filterValue as Record<string, unknown>)
        : {};
    const start = parseDateValue(payload.start);
    const end = parseDateValue(payload.end);
    const t = rowTime as number;
    if (start && t < start.getTime() / 1000) return false;
    if (end && t > end.getTime() / 1000) return false;
    return true;
  }

  const numericValue = normalizeComparable(rowValue, 'numeric') as number | null;
  if (numericValue === null) return false;
  const payload =
    filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue)
      ? (filterValue as Record<string, unknown>)
      : {};
  const min = parseNumericValue(payload.min);
  const max = parseNumericValue(payload.max);
  if (min !== null && numericValue < min) return false;
  if (max !== null && numericValue > max) return false;
  return true;
}

export function applyDashboardFilters(
  rows: DashboardRow[],
  filters: DashboardFilterDef[],
  filterValues: FilterValues,
  datasetSchema: DatasetSchemaColumn[],
): DashboardRow[] {
  if (!rows.length || !filters.length) return rows;
  return rows.filter((row) =>
    filters.every((def) =>
      rowMatchesFilter(row, def, filterValues[normText(def.id).trim() || def.field], datasetSchema),
    ),
  );
}

export function distinctFieldValues(rows: DashboardRow[], field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const v = row[field];
    if (v === null || v === undefined || v === '') continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
