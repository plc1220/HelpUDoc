/** Compatibility shim: prefer `@helpudoc/dashboard-runtime`. */
export type {
  ChartRuntimeDef,
  DashboardFilterDef,
  DashboardRow,
  DatasetSchemaColumn,
  FilterValues,
} from '../../dashboard-runtime/src/index';
export {
  applyDashboardFilters,
  inferFieldType,
  distinctFieldValues,
} from '../../dashboard-runtime/src/index';
export { aggregateChartRows } from '../../dashboard-runtime/src/index';
export { buildPlotlyPayload } from '../../dashboard-runtime/src/index';
