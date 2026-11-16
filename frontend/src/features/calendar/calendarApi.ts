import { apiFetch, buildApiUrl } from '../../services/apiClient';
export type CalendarSource = { id: string; summary: string; visible: boolean; can_edit: boolean; accessRole: string; timeZone: string; last_sync_at?: string; sync_state: string };
export type CalendarItem = {
  id: string; kind: 'MEETING' | 'AUTOMATION' | 'COMMITMENT'; title: string; start: string; end?: string;
  all_day?: boolean; time_zone?: string; calendar_id?: string; calendar_name?: string; etag?: string;
  description?: string; location?: string; attendees?: Array<{ email: string; responseStatus?: string }>;
  recurrence?: string[]; recurring_event_id?: string; visibility?: string; url?: string; sync_state?: string;
  capabilities: { can_edit: boolean; can_delete: boolean }; status?: string;
  workspace_id?: string; workspace_name?: string; schedule_id?: string; source_ref?: string;
};
export type FileLink = { file_ref: string; title: string; url?: string; link_id?: string; modified_at?: string; reason?: string; changed?: boolean; scope?: 'single' | 'series'; provenance?: 'MANUAL' | 'EXPLICIT_SOURCE' | 'INFERRED' | 'OUTPUT'; inherited?: boolean };
export type Brief = { id: string; status: 'QUEUED' | 'READY' | 'FAILED'; error?: string; stale?: boolean; sections?: Record<string, string>; gaps?: string[]; citations?: Array<{ title: string; url?: string; retrieved_at: string }> };
export type Connection = { configured: boolean; connected: boolean; can_edit: boolean; drive_enabled: boolean; accounts?: Array<{ id: string; principal: string; can_edit: boolean; drive_enabled: boolean }> };
export type CalendarProposal = { id: string; method: 'POST' | 'PATCH' | 'DELETE'; event_ref?: string; selected_event_ref: string; before?: CalendarItem; event_etag?: string; status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'REJECTED'; expires_at: string; result?: CalendarItem; input: Partial<{ title: string; start: string; end: string; all_day: boolean; time_zone: string; calendar_id: string; attendees: Array<{ email: string }>; description: string; location: string; recurrence: string[]; visibility: string; scope: string; send_updates: string }> };
export class CalendarRequestError extends Error { code: string; constructor(message: string, code: string) { super(message); this.code = code; } }
export async function calendarApi<T>(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const response = await apiFetch(buildApiUrl(`/v1${path}`), { method, headers: { 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new CalendarRequestError(data.error || 'Calendar request failed', data.code || 'REQUEST_FAILED');
  return data as T;
}
export function googleConnectUrl(drive = false, edit = false) {
  const url = buildApiUrl('/auth/google/start');
  url.searchParams.set('returnTo', `${window.location.pathname}?calendar=open`);
  url.searchParams.set('calendar', 'true');
  url.searchParams.set('extraScopes', ['calendar.calendarlist.readonly', edit ? 'calendar.events' : 'calendar.events.readonly', ...(drive ? ['drive.file'] : [])].map(s => `https://www.googleapis.com/auth/${s}`).join(' '));
  return url.toString();
}
