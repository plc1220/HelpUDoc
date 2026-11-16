import { CalendarError } from './calendarModel';
import { readBoundedResponse, type BriefEvidence } from './calendarBrief';
import { GoogleOAuthService, GoogleOAuthTokenMissingError } from './googleOAuthService';

export const CALENDAR_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ID = /^[a-f0-9]{1,64}$/i;
const MAX_THREADS = 5, MAX_MESSAGES = 5, TEXT_BUDGET = 8000, MAX_MESSAGE_TEXT = 4000;
type Header = { name?: string; value?: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; attachmentId?: string }; parts?: Part[] };
type Message = { id?: string; threadId?: string; internalDate?: string; payload?: Part };
type Thread = { id?: string; historyId?: string; messages?: Message[] };
export type GmailThreadCandidate = { id: string; title: string; from?: string; date?: string; url: string; revision: string; retrieved_at: string };

const denied = () => new CalendarError(403, 'GMAIL_NOT_CONNECTED', 'Gmail is not connected for meeting briefs. Prepare without Gmail or review your existing Google connection.');
const unavailable = () => new CalendarError(503, 'GMAIL_UNAVAILABLE', 'Gmail could not confirm the selected source. Prepare without Gmail or retry.');
const authFailure = (error: unknown) => error instanceof CalendarError && ['GMAIL_NOT_CONNECTED', 'GMAIL_PERMISSION_DENIED'].includes(error.code);
const timestamp = () => new Date().toISOString();
const header = (message: Message | undefined, name: string) => (message?.payload?.headers?.find(value => value.name?.toLowerCase() === name.toLowerCase())?.value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
function messageDate(message: Message | undefined): string | undefined {
  const number = Number(message?.internalDate);
  return Number.isFinite(number) && number > 0 && number <= 8.64e15 ? new Date(number).toISOString() : undefined;
}
function selectedIds(ids: readonly string[]) {
  if (!Array.isArray(ids) || ids.length > MAX_THREADS || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw new CalendarError(422, 'GMAIL_INVALID_SELECTION', 'Choose up to five Gmail threads from the search results.');
  return [...new Set(ids)];
}
const deepLink = (mailbox: string, id: string) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${id}`;

function htmlText(input: string): string {
  return input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, name: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()] || ' ')
    .replace(/[ \t]+/g, ' ').trim();
}
function plainText(payload?: Part): string {
  const plain: string[] = [], html: string[] = []; let visited = 0;
  const walk = (part: Part | undefined, depth = 0) => {
    if (!part || depth > 12 || ++visited > 128 || part.filename || part.body?.attachmentId) return;
    const encoded = part.body?.data;
    if (encoded && encoded.length <= 128000 && /^[A-Za-z0-9_-]*={0,2}$/.test(encoded) && ['text/plain', 'text/html'].includes(part.mimeType || '')) {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8').slice(0, MAX_MESSAGE_TEXT * 2);
      (part.mimeType === 'text/plain' ? plain : html).push(part.mimeType === 'text/plain' ? decoded : htmlText(decoded));
    }
    for (const child of (part.parts || []).slice(0, 128)) walk(child, depth + 1);
  };
  walk(payload);
  return (plain.length ? plain : html).join('\n').slice(0, MAX_MESSAGE_TEXT).trim();
}

/** User-triggered Gmail sources only. No automatic mailbox search, no new grants,
 * no attachments, no persistent body cache, and no write methods.
 * API contracts: developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
 * and developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get. */
export class CalendarGmailSources {
  constructor(private readonly oauth: Pick<GoogleOAuthService, 'getDelegatedAccessToken'>, private readonly transport: typeof fetch = fetch) {}
  private async token(userId: string) {
    try { return (await this.oauth.getDelegatedAccessToken(userId, [CALENDAR_GMAIL_SCOPE], true, 'google')).accessToken; }
    catch (error) { throw error instanceof GoogleOAuthTokenMissingError ? denied() : unavailable(); }
  }
  private async get<T>(token: string, route: string, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unavailable();
    let response: Response;
    try { response = await this.transport(`${BASE}${route}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(Math.min(8000, remaining)) }); }
    catch { throw unavailable(); }
    if (response.status === 401) throw denied();
    if (response.status === 403) throw new CalendarError(403, 'GMAIL_PERMISSION_DENIED', 'Gmail does not permit access to this source. Prepare without Gmail or review your existing Google connection.');
    if (response.status === 404) throw new CalendarError(404, 'GMAIL_SOURCE_UNAVAILABLE', 'The selected Gmail thread is unavailable.');
    if (!response.ok) throw unavailable();
    try { return JSON.parse(await readBoundedResponse(response, 128000)) as T; }
    catch { throw new CalendarError(422, 'GMAIL_SOURCE_UNREADABLE', 'The selected Gmail source exceeds the supported response limit or could not be read.'); }
  }
  private async mailbox(token: string, deadline: number) {
    const profile = await this.get<{ emailAddress?: string }>(token, '/profile?fields=emailAddress', deadline);
    if (!profile.emailAddress || profile.emailAddress.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw unavailable();
    return profile.emailAddress;
  }
  private async metadata(token: string, id: string, deadline: number): Promise<Thread> {
    const query = new URLSearchParams({ format: 'metadata', fields: 'id,historyId,messages(id,internalDate,payload(headers))' });
    for (const name of ['Subject', 'From', 'To']) query.append('metadataHeaders', name);
    const result = await this.get<Thread>(token, `/threads/${encodeURIComponent(id)}?${query}`, deadline);
    if (result.id !== id || !result.historyId || !/^\d{1,40}$/.test(result.historyId)) throw new CalendarError(422, 'GMAIL_SOURCE_UNREADABLE', 'Gmail did not return a verifiable thread revision.');
    return result;
  }
  async search(userId: string, q: string): Promise<GmailThreadCandidate[]> {
    const query = typeof q === 'string' ? q.trim() : '';
    if (!query || query.length > 200) throw new CalendarError(422, 'GMAIL_INVALID_SELECTION', 'Enter a Gmail search of up to 200 characters.');
    const token = await this.token(userId), deadline = Date.now() + 20000;
    const mailbox = await this.mailbox(token, deadline);
    const params = new URLSearchParams({ q: query, maxResults: String(MAX_THREADS), fields: 'threads(id)' });
    const found = await this.get<{ threads?: Array<{ id?: string }> }>(token, `/threads?${params}`, deadline);
    const ids = [...new Set((found.threads || []).map(value => value.id).filter((id): id is string => typeof id === 'string' && ID.test(id)))].slice(0, MAX_THREADS);
    const candidates = await Promise.all(ids.map(async (id): Promise<GmailThreadCandidate | undefined> => {
      try {
        const thread = await this.metadata(token, id, deadline);
        const latest = [...(thread.messages || [])].sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))[0];
        return { id, title: header(latest, 'Subject') || 'Gmail thread', from: header(latest, 'From') || undefined, date: messageDate(latest), url: deepLink(mailbox, id), revision: thread.historyId!, retrieved_at: timestamp() };
      } catch (error) { if (authFailure(error)) throw error; return undefined; }
    }));
    return candidates.filter((value): value is GmailThreadCandidate => Boolean(value));
  }
  async read(userId: string, ids: readonly string[]): Promise<{ evidence: BriefEvidence[]; gaps: string[] }> {
    const selected = selectedIds(ids);
    if (!selected.length) return { evidence: [], gaps: [] };
    const token = await this.token(userId), deadline = Date.now() + 25000;
    const mailbox = await this.mailbox(token, deadline);
    const results = await Promise.all(selected.map(async (id, index) => {
      const gaps: string[] = [];
      try {
        const thread = await this.metadata(token, id, deadline);
        const messages = (thread.messages || []).filter(message => typeof message.id === 'string' && ID.test(message.id));
        const recent = [...messages].sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0)).slice(0, MAX_MESSAGES);
        if (messages.length > MAX_MESSAGES) gaps.push(`Selected Gmail thread ${index + 1}: only the latest five messages were considered.`);
        const reviewed: Array<{ id: string; date?: string; from: string; to: string; subject: string; text: string }> = [];
        let remaining = TEXT_BUDGET;
        for (const message of recent) {
          if (remaining <= 0) { gaps.push(`Selected Gmail thread ${index + 1}: remaining messages exceeded the text limit and were not reviewed.`); break; }
          try {
            const data = await this.get<Message>(token, `/messages/${message.id}?format=full&fields=id,threadId,internalDate,payload`, deadline);
            if (data.id !== message.id || data.threadId !== id) throw unavailable();
            const text = plainText(data.payload).slice(0, remaining);
            if (!text) { gaps.push(`Selected Gmail thread ${index + 1}: a message had no supported inline text and was not reviewed.`); continue; }
            reviewed.push({ id: message.id!, date: messageDate(data), from: header(data, 'From'), to: header(data, 'To'), subject: header(data, 'Subject'), text });
            remaining -= text.length;
          } catch (error) { if (authFailure(error)) throw error; gaps.push(`Selected Gmail thread ${index + 1}: a message could not be read and was not reviewed.`); }
        }
        gaps.push(`Selected Gmail thread ${index + 1}: attachments were not retrieved; inline message text is limited to 4,000 characters per message and 8,000 per thread.`);
        if (!reviewed.length) return { gaps: [...gaps, `Selected Gmail thread ${index + 1} supplied no readable message text and was excluded.`] };
        const evidence: BriefEvidence = { ref: `gmail:${id}`, source: 'gmail', title: header(recent[0], 'Subject') || 'Selected Gmail thread', url: deepLink(mailbox, id), revision: thread.historyId!, retrieved_at: timestamp(), text: JSON.stringify({ mailbox, reviewed_messages: reviewed, total_messages: messages.length }) };
        return { evidence, gaps };
      } catch (error) { if (authFailure(error)) throw error; return { gaps: [`Selected Gmail thread ${index + 1} was unavailable or unreadable and was not reviewed.`] }; }
    }));
    return { evidence: results.flatMap(result => result.evidence ? [result.evidence] : []), gaps: results.flatMap(result => result.gaps) };
  }
  async validate(userId: string, evidence: readonly BriefEvidence[]): Promise<boolean> {
    const mail = evidence.filter(value => value.source === 'gmail');
    if (!mail.length) return true;
    try {
      const ids = selectedIds(mail.map(value => value.ref.startsWith('gmail:') ? value.ref.slice(6) : ''));
      if (ids.length !== mail.length) return false;
      const token = await this.token(userId), deadline = Date.now() + 20000;
      const mailbox = await this.mailbox(token, deadline);
      const results = await Promise.all(mail.map(async source => {
        const id = source.ref.slice(6);
        if (source.url !== deepLink(mailbox, id)) return false;
        const current = await this.metadata(token, id, deadline);
        return current.historyId === source.revision;
      }));
      return results.every(Boolean);
    } catch { return false; }
  }
}
