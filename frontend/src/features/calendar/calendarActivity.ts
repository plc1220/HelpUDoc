import { calendarApi } from './calendarApi';

export type CalendarActivitySignal = 'ui_open' | 'ui_editor_open' | 'ui_conflict_resolved' | 'ui_brief_requested' | 'ui_citation_open' | 'ui_commitment_confirmed';

/** Aggregate counters only: never attach event, document, account, or user data. */
export function calendarActivity(signal: CalendarActivitySignal): void {
  void calendarApi('/calendar/activity', 'POST', { signal }).catch(() => undefined);
}
