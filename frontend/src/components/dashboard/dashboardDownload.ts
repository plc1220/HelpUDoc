import { apiFetch, buildApiUrl } from '../../services/apiClient';

function normalizePath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

/** Fetch snapshot HTML as a download, avoiding same-origin iframe execution. */
export async function downloadDashboardHtmlExport(workspaceId: string, dashboardPath: string, filename?: string) {
  const base = normalizePath(dashboardPath);
  const path = `${base}/dashboard.snapshot.html`;
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview/raw`);
  url.searchParams.set('path', path);
  const res = await apiFetch(url.toString());
  if (!res.ok) {
    throw new Error('Failed to download HTML export');
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'dashboard.snapshot.html';
  a.click();
  URL.revokeObjectURL(a.href);
}
