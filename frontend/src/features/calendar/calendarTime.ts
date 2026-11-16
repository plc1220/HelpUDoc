export const dayKey = (value: string | Date, zone: string): string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export function addDays(day: string, count: number) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); }
export function localTime(value: string, zone: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T09:00`;
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return parts.replace(' ', 'T');
}
/** Convert a wall-clock time in an IANA zone, rejecting nonexistent DST times. */
export function zonedInstant(local: string, zone: string, preferredInstant?: string): string {
  if (preferredInstant && localTime(preferredInstant, zone) === local) return preferredInstant;
  const naive = Date.parse(`${local}:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== local) throw new Error('Enter a valid date and time');
  let result = naive;
  for (let i = 0; i < 4; i++) {
    const rendered = Date.parse(`${localTime(new Date(result).toISOString(), zone)}:00Z`);
    const delta = naive - rendered;
    if (!delta) return new Date(result).toISOString();
    result += delta;
  }
  throw new Error('This local time does not exist because of a daylight-saving transition. Choose another time.');
}
export function viewDays(anchor: string, mode: string) {
  const first = mode === 'month' ? `${anchor.slice(0, 7)}-01` : anchor;
  const start = mode === 'month' || mode === 'week' ? addDays(first, -(new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7) : anchor;
  const count = mode === 'month' ? 42 : mode === 'day' ? 1 : mode === 'agenda' ? 14 : 7;
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}
export function timeLabel(value: string, zone: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'All day' : new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }

export function addMonths(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`), original = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + count);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(original, last)); return date.toISOString().slice(0, 10);
}
export function intersectsDay(item: { start: string; end?: string; all_day?: boolean }, day: string, zone: string) {
  const start = dayKey(item.start, zone), end = item.end ? dayKey(item.end, zone) : start;
  if (item.all_day) return start <= day && day < (item.end ? end : addDays(start, 1));
  if (start > day || end < day) return false;
  return day !== end || day === start || !item.end || !localTime(item.end, zone).endsWith('T00:00');
}
