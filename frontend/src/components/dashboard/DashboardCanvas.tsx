// PR 10 (frontend-workspace-split): canonical location is now
// `frontend/src/features/dashboard/components/DashboardCanvas.tsx`.
// This shim preserves the legacy import path during the rename.
export { default } from '../../features/dashboard/components/DashboardCanvas';
export type * from '../../features/dashboard/components/DashboardCanvas';
