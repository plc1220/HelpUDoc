export const resolveWorkspaceCanvasTitle = (input: {
  selectedDashboardPath?: string | null;
  dashboardDisplayName?: string | null;
  selectedFileName?: string | null;
}): string => {
  if (String(input.selectedDashboardPath || '').trim()) {
    return String(input.dashboardDisplayName || '').trim() || 'Dashboard';
  }
  return String(input.selectedFileName || '').trim() || 'Editor';
};
