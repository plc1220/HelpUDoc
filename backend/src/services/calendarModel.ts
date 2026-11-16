import { createHash } from 'crypto';
import { z } from 'zod';

export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const DRIVE_LINK_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export class CalendarError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function calendarCacheSettings(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new CalendarError(503, 'CACHE_CONFIG_INVALID', 'Calendar cache settings need administrator attention');
    return Number(raw);
  };
  return { maxEvents: integer('CALENDAR_CACHE_MAX_EVENTS', 5000, 50000), tombstoneDays: integer('CALENDAR_CACHE_TOMBSTONE_DAYS', 90, 365) };
}
export const eventInput = z.object({
  calendar_id: z.string().min(1).max(1024).optional(),
  title: z.string().trim().min(1).max(1024).optional(),
  start: z.string().max(80).optional(), end: z.string().max(80).optional(),
  all_day: z.boolean().optional(), time_zone: z.string().max(120).optional(),
  description: z.string().max(16000).optional(), location: z.string().max(2048).optional(),
  attendees: z.array(z.object({ email: z.email() })).max(100).optional(),
  recurrence: z.array(z.string().max(512).regex(/^(RRULE|RDATE|EXDATE):/)).max(10).optional(),
  visibility: z.enum(['default', 'public', 'private']).optional(),
  send_updates: z.enum(['all', 'externalOnly', 'none']).default('all'),
  scope: z.enum(['single', 'series']).default('single'),
}).strict();
export type EventInput = z.infer<typeof eventInput>;
export type GoogleEvent = {
  id: string; etag?: string; updated?: string; summary?: string; description?: string; location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  status?: string; visibility?: string; recurrence?: string[]; recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string }; htmlLink?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string; self?: boolean }>;
  [key: string]: unknown;
};
export function eventRef(calendarId: string, eventId: string) {
  return `meeting:${Buffer.from(JSON.stringify([calendarId, eventId])).toString('base64url')}`;
}
export function parseEventRef(ref: string): [string, string] {
  try {
    if (!ref.startsWith('meeting:') || ref.length > 4096) throw new Error();
    const value = JSON.parse(Buffer.from(ref.slice(8), 'base64url').toString());
    if (!Array.isArray(value) || value.length !== 2 || value.some(x => typeof x !== 'string' || !x)) throw new Error();
    return value as [string, string];
  } catch { throw new CalendarError(400, 'INVALID_EVENT_REF', 'Invalid meeting reference'); }
}
export function providerBody(input: EventInput, previous?: GoogleEvent) {
  const body: Record<string, unknown> = {};
  const zone = input.time_zone || previous?.start?.timeZone || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw new CalendarError(422, 'INVALID_EVENT', 'Choose a valid IANA timezone'); }
  const allDay = input.all_day ?? Boolean(previous?.start?.date);
  const start = input.start ?? previous?.start?.date ?? previous?.start?.dateTime;
  const end = input.end ?? previous?.end?.date ?? previous?.end?.dateTime;
  const valid = (value?: string) => {
    if (!value) return false;
    if (!allDay) {
      const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
    }
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(start) || !valid(end) || (allDay ? start! >= end! : Date.parse(start!) >= Date.parse(end!))) {
    throw new CalendarError(422, 'INVALID_EVENT', 'End must follow start; timed events need an explicit UTC offset');
  }
  if (!previous && !input.title) throw new CalendarError(422, 'INVALID_EVENT', 'Enter an event title');
  if (input.start !== undefined || input.end !== undefined || input.all_day !== undefined || input.time_zone !== undefined || !previous) {
    body.start = allDay ? { date: start } : { dateTime: start, timeZone: zone };
    body.end = allDay ? { date: end } : { dateTime: end, timeZone: zone };
  }
  for (const [from, to] of [['title', 'summary'], ['description', 'description'], ['location', 'location'], ['recurrence', 'recurrence'], ['visibility', 'visibility']] as const) {
    if (input[from] !== undefined) body[to] = input[from];
  }
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map(a => ({ ...previous?.attendees?.find(old => old.email.toLowerCase() === a.email.toLowerCase()), ...a }));
  }
  return body;
}
export function deterministicEventId(userId: string, key: string) {
  return createHash('sha256').update(`${userId}:${key}`).digest('hex');
}

/** Date-only events occupy calendar-local days, rather than UTC midnights. */
export function eventOverlapsRange(event: GoogleEvent, from: string, to: string, timeZone: string) {
  if (event.start?.date && event.end?.date) {
    const parts = (instant: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const lower = parts(from), upper = parts(to);
    const lowerDay = `${lower.year}-${lower.month}-${lower.day}`;
    let upperDay = `${upper.year}-${upper.month}-${upper.day}`;
    if (upper.hour !== '00' || upper.minute !== '00' || upper.second !== '00' || new Date(to).getUTCMilliseconds()) upperDay = new Date(Date.parse(`${upperDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return event.start.date < upperDay && event.end.date > lowerDay;
  }
  return Boolean(event.start?.dateTime && event.end?.dateTime && Date.parse(event.start.dateTime) < Date.parse(to) && Date.parse(event.end.dateTime) > Date.parse(from));
}

export function sourceKey(connectionId: string, calendarId: string) {
  return `source:${Buffer.from(JSON.stringify([connectionId, calendarId])).toString('base64url')}`;
}
export function parseSourceKey(value: string): [string, string] {
  try {
    if (!value.startsWith('source:')) throw new Error();
    const parts = JSON.parse(Buffer.from(value.slice(7), 'base64url').toString());
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== 'string' || !p)) throw new Error();
    return parts as [string, string];
  } catch { throw new CalendarError(400, 'INVALID_SOURCE', 'Choose a connected Google calendar'); }
}
