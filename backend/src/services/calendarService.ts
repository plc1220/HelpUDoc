import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { Knex } from 'knex';
import type { FileService } from './fileService';
import type { WorkspaceCollaborationService } from './workspaceCollaborationService';
import { analyzeBrief, readBoundedResponse, readBoundedBytes, type BriefAnalyzer, type BriefEvidence } from './calendarBrief';
import { GoogleOAuthService, GoogleOAuthTokenMissingError } from './googleOAuthService';
import { encryptOAuthSecret, decryptOAuthSecret, type OAuthProvider } from './userOAuthTokenService';
import { CalendarError, CALENDAR_LIST_SCOPE, CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE, DRIVE_LINK_SCOPE, eventRef, parseEventRef, providerBody, deterministicEventId, eventOverlapsRange, calendarCacheSettings, sourceKey, parseSourceKey, type GoogleEvent, type EventInput } from './calendarModel';
import { calendarTelemetry, calendarProviderAction } from './calendarTelemetry';
import { CalendarGmailSources } from './calendarGmailSources';
import { CalendarDocumentText } from './calendarDocumentText';

type Source = { connection_id?: string; principal?: string; external_calendar_id?: string; id: string; summary: string; accessRole: string; timeZone: string; visible: boolean; sync_token?: string; last_sync_at?: string; sync_state?: string; can_edit?: boolean };
type Row<T = Record<string, unknown>> = { id: string; userId: string; resource: string; data: T; updatedAt: string };
type LinkScope = 'single' | 'series';
type LinkSubject = { title?: string; name?: string; description?: string; location?: string; recurring_event_id?: string; recurrence?: string[]; workspace_id?: string; workspaceId?: string };
type LinkData = { file_ref: string; revision?: string; scope?: LinkScope; provenance?: string; state?: string; source_run_id?: string; output_version?: string };
type RunSubject = { workspaceId: string; userId?: string; status: string };
type CalendarFile = { file_ref: string; title: string; mime_type?: string; url?: string; modified_at?: string; revision?: string; checked_at: string };
const base = 'https://www.googleapis.com/calendar/v3';
const enc = encodeURIComponent;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();

export class CalendarService {
  private timer?: ReturnType<typeof setInterval>;
  private retryAfter = new Map<string, number>();
  constructor(private db: Knex, private oauth: GoogleOAuthService, private transport: typeof fetch = fetch, private workspaceFiles?: FileService, private collaboration?: Pick<WorkspaceCollaborationService, 'getObject'>, private analyzer: BriefAnalyzer = analyzeBrief, private runReader?: (id: string) => Promise<RunSubject | null>, private mail: Pick<CalendarGmailSources, 'search' | 'read' | 'validate'> = new CalendarGmailSources(oauth, transport), private documentText: Pick<CalendarDocumentText, 'read'> = new CalendarDocumentText()) {}
  private async put(table: string, userId: string, resource: string, data: unknown, id = hash(`${userId}:${resource}`)) {
    await this.db(table).insert({ id, userId, resource, data: JSON.stringify(data) }).onConflict('id').merge({ data: JSON.stringify(data), updatedAt: this.db.fn.now() });
    return id;
  }
  private async get<T>(table: string, userId: string, resource: string, executor: Knex = this.db): Promise<T | undefined> {
    return (await executor<Row<T>>(table).where({ userId, resource }).first())?.data;
  }
  private async assertConnected(userId: string, executor: Knex = this.db) {
    const state = await this.get<{ disabled: boolean }>('calendar_sources', userId, '@connection', executor);
    if (state?.disabled) throw new CalendarError(401, 'REAUTH_REQUIRED', 'Connect Google Calendar to continue');
    const accounts = await this.oauth.listCalendarAccounts(userId, executor);
    const scopes = [...new Set(accounts.flatMap(account => account.scopes))];
    if (!scopes.length) {
      await this.purgeEvidence(userId, executor);
      throw new CalendarError(401, 'REAUTH_REQUIRED', 'Connect Google Calendar to continue');
    }
    return scopes;
  }
  private async purgeEvidence(userId: string, executor: Knex = this.db) {
    await Promise.all(['calendar_events', 'calendar_briefs', 'calendar_mutations', 'calendar_proposals'].map(table => executor(table).where({ userId }).del()));
  }
  private async purgeSourceEvidence(userId: string, calendarId: string, executor?: Knex) {
    const purge = async (tx: Knex) => {
      const events = await tx<Row>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [calendarId]);
      await tx('calendar_briefs').where({ userId }).whereIn('resource', events.map(event => event.resource)).del();
      await tx('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [calendarId]).del();
      await tx('calendar_mutations').where({ userId }).whereRaw("data->'result'->>'calendar_id' = ?", [calendarId]).del();
      await tx('calendar_proposals').where({ userId }).del();
    };
    if (executor) await purge(executor); else await this.db.transaction(purge);
  }
  private async cleanupTransactionFailure(userId: string, calendarId: string, error: unknown) {
    // The transaction has released its sole connection before cleanup starts.
    // Otherwise revocation either deadlocks on a second lease or rolls back.
    if (!(error instanceof CalendarError)) return;
    if (error.status === 401) {
      await this.oauth.disconnectCalendarAccount(userId, parseSourceKey(calendarId)[0] as OAuthProvider);
      await this.purgeEvidence(userId);
    } else if ([403, 404].includes(error.status)) {
      await this.purgeSourceEvidence(userId, calendarId);
      await this.db('calendar_sources').where({ userId, resource: calendarId }).del();
    }
  }
  async connection(userId: string) {
    const accounts = await this.oauth.listCalendarAccounts(userId);
    const scopes = [...new Set(accounts.flatMap(account => account.scopes))];
    const state = await this.get<{ disabled: boolean }>('calendar_sources', userId, '@connection');
    const connected = !state?.disabled && scopes.some(s => [CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(s));
    if (!connected) await this.purgeEvidence(userId);
    return { configured: this.oauth.isConfigured(), connected, can_edit: scopes.includes(CALENDAR_WRITE_SCOPE) || scopes.includes('https://www.googleapis.com/auth/calendar'), drive_enabled: scopes.includes(DRIVE_LINK_SCOPE), accounts: accounts.map(a => ({ id: a.id, principal: a.principal, can_edit: a.scopes.includes(CALENDAR_WRITE_SCOPE), drive_enabled: a.scopes.includes(DRIVE_LINK_SCOPE) })), scopes };
  }
  async connect(userId: string) { await this.put('calendar_sources', userId, '@connection', { disabled: false }); }
  async disconnect(userId: string) {
    await this.put('calendar_sources', userId, '@connection', { disabled: true });
    const watches = await this.db<Row>('calendar_watches').where({ userId });
    for (const row of watches) {
      try { await this.request(userId, '/channels/stop', { method: 'POST', body: JSON.stringify({ id: row.data.channel_id, resourceId: row.data.resource_id }) }, false, false, parseSourceKey(row.resource)[0]); } catch { /* channels expire independently */ }
    }
    await Promise.all(['calendar_sources', 'calendar_events', 'calendar_briefs', 'calendar_watches', 'calendar_mutations', 'calendar_proposals'].map(table => this.db(table).where({ userId }).whereNot({ resource: '@connection' }).del()));
    for (const account of await this.oauth.listCalendarAccounts(userId)) await this.oauth.disconnectCalendarAccount(userId, account.id);
    await this.audit(userId, 'disconnect', 'google_calendar', {});
  }
  async disconnectAccount(userId: string, connectionId: string) {
    const account = (await this.oauth.listCalendarAccounts(userId)).find(item => item.id === connectionId);
    if (!account) throw new CalendarError(404, 'NOT_FOUND', 'Google account is not connected');
    const sources = await this.db<Row<Source>>('calendar_sources').where({ userId }).whereRaw("data->>'connection_id' = ?", [connectionId]);
    for (const source of sources) {
      const watch = await this.get<Record<string, unknown>>('calendar_watches', userId, source.resource);
      if (watch) try { await this.request(userId, '/channels/stop', { method: 'POST', body: JSON.stringify({ id: watch.channel_id, resourceId: watch.resource_id }) }, false, false, connectionId); } catch { /* channels also expire at Google */ }
      const events = await this.db<Row>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [source.resource]);
      await this.db('calendar_briefs').where({ userId }).whereIn('resource', events.map(event => event.resource)).del();
      await this.db('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [source.resource]).del();
      await this.db('calendar_watches').where({ userId, resource: source.resource }).del();
      await this.db('calendar_sources').where({ userId, id: source.id }).del();
    }
    await this.db('calendar_mutations').where({ userId }).whereRaw("data->'result'->>'connection_id' = ?", [connectionId]).del();
    await this.oauth.disconnectCalendarAccount(userId, account.id);
    await this.db('calendar_proposals').where({ userId }).del();
    await this.audit(userId, 'disconnect_account', connectionId, {});
  }
  private async request<T = Record<string, unknown>>(userId: string, path: string, init: RequestInit = {}, write = false, drive = false, connectionId?: string, format: 'json' | 'text' | 'binary' = 'json', executor?: Knex): Promise<T> {
    const calendarMatch = path.match(/^\/(?:calendars|users\/me\/calendarList)\/([^/?]+)/);
    if (calendarMatch) {
      const [connection, externalId] = parseSourceKey(decodeURIComponent(calendarMatch[1]));
      connectionId = connection;
      path = path.replace(calendarMatch[1], enc(externalId));
    }
    const accounts = await this.oauth.listCalendarAccounts(userId, executor);
    const account = accounts.find(a => a.id === connectionId);
    if (!account) throw new CalendarError(401, 'REAUTH_REQUIRED', 'This Google account is no longer connected');
    const cooldownKey = `${userId}:${account.id}`;
    if ((this.retryAfter.get(cooldownKey) || 0) > Date.now()) throw new CalendarError(503, 'PROVIDER_RATE_LIMITED', 'Google is rate-limiting this account. Please retry later.');
    const scopes = account.scopes;
    const scope = drive ? DRIVE_LINK_SCOPE : write ? CALENDAR_WRITE_SCOPE : path.startsWith('/users/me/calendarList') ? CALENDAR_LIST_SCOPE : CALENDAR_READ_SCOPE;
    const broad = !drive && scopes.find(s => ['https://www.googleapis.com/auth/calendar', ...(!write ? ['https://www.googleapis.com/auth/calendar.readonly', ...(!path.startsWith('/users/me/calendarList') ? [CALENDAR_WRITE_SCOPE] : [])] : [])].includes(s));
    if (!scopes.includes(broad || scope)) throw new CalendarError(403, 'PERMISSION_DENIED', 'Enable the required Google permission for this account');
    let token: string;
    try { token = (await this.oauth.getDelegatedAccessToken(userId, [broad || scope], true, account.id as OAuthProvider, executor)).accessToken; }
    catch (error) {
      if (error instanceof GoogleOAuthTokenMissingError) {
        calendarTelemetry.recordSignal('grant_revoked');
        if (!executor) { await this.oauth.disconnectCalendarAccount(userId, account.id); await this.purgeEvidence(userId); }
        throw new CalendarError(401, 'REAUTH_REQUIRED', 'Reconnect Google and approve the required permission');
      }
      throw error;
    }
    const url = drive ? `https://www.googleapis.com/drive/v3${path}` : `${base}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: globalThis.Response;
      const started = performance.now(), action = calendarProviderAction(path, init.method, drive);
      try { response = await this.transport(url, { ...init, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } }); }
      catch { calendarTelemetry.recordProvider({ action, status: 'network_error', durationMs: performance.now() - started }); throw new CalendarError(503, 'PROVIDER_UNAVAILABLE', 'Google is unavailable. Your change has not been confirmed. Retry safely.'); }
      calendarTelemetry.recordProvider({ action, status: response.status, durationMs: performance.now() - started });
      if (response.ok) return (response.status === 204 ? {} : format === 'text' ? await readBoundedResponse(response) : format === 'binary' ? await readBoundedBytes(response, 8 * 1024 * 1024) : await response.json()) as T;
      if (response.status === 429) {
        const hint = response.headers.get('Retry-After');
        const seconds = hint && Number.isFinite(Number(hint)) ? Number(hint) : hint ? Math.max(0, (Date.parse(hint) - Date.now()) / 1000) : 30;
        this.retryAfter.set(cooldownKey, Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 30) * 1000);
        throw new CalendarError(503, 'PROVIDER_RATE_LIMITED', 'Google is rate-limiting this account. Please retry later.');
      }
      if (response.status >= 500 && attempt < 2 && (!init.method || init.method === 'GET')) {
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); continue;
      }
      if (response.status === 401) { calendarTelemetry.recordSignal('grant_revoked'); if (!executor) { await this.oauth.disconnectCalendarAccount(userId, account.id); await this.purgeEvidence(userId); } throw new CalendarError(401, 'REAUTH_REQUIRED', 'Google authorization expired. Reconnect your account.'); }
      if (response.status === 403) throw new CalendarError(403, 'PERMISSION_DENIED', 'Google does not permit this action. Check calendar access and granted permissions.');
      if ([409, 412].includes(response.status)) { calendarTelemetry.recordSignal('mutation_conflict'); throw new CalendarError(409, 'CALENDAR_CONFLICT', 'This event changed in Google. Reload the latest version before saving.'); }
      if (response.status === 410) throw new CalendarError(410, 'SYNC_TOKEN_EXPIRED', 'Calendar sync must be rebuilt');
      if (response.status === 404) throw new CalendarError(404, 'NOT_FOUND', 'This source is no longer available');
      throw new CalendarError(response.status >= 500 || response.status === 429 ? 503 : 422, 'PROVIDER_ERROR', 'Google could not confirm the request. Review the event and try again.');
    }
    throw new CalendarError(503, 'PROVIDER_UNAVAILABLE', 'Google is temporarily unavailable');
  }
  async sources(userId: string) {
    await this.assertConnected(userId);
    const items: Source[] = [];
    for (const account of await this.oauth.listCalendarAccounts(userId)) {
      let page: string | undefined;
      const accountItems: Source[] = [];
      try {
        do {
          const result = await this.request<{ items?: Source[]; nextPageToken?: string }>(userId, `/users/me/calendarList?maxResults=250${page ? `&pageToken=${enc(page)}` : ''}`, {}, false, false, account.id);
          accountItems.push(...(result.items || []).map(source => ({ ...source, external_calendar_id: source.id, connection_id: account.id, principal: account.principal, id: sourceKey(account.id, source.id), can_edit: account.scopes.includes(CALENDAR_WRITE_SCOPE) && ['writer', 'owner'].includes(source.accessRole) }))); page = result.nextPageToken;
        } while (page);
        items.push(...accountItems);
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        if (error.status === 503) {
          const cached = await this.db<Row<Source>>('calendar_sources').where({ userId }).whereRaw("data->>'connection_id' = ?", [account.id]);
          items.push(...cached.map(row => ({ ...row.data, can_edit: false, sync_state: 'STALE' })));
        } else if (![401, 403, 404].includes(error.status)) throw error;
      }
    }
    const keep: string[] = ['@connection'];
    for (const source of items.filter(s => ['reader', 'writer', 'owner'].includes(s.accessRole))) {
      const old = await this.get<Source>('calendar_sources', userId, source.id);
      const metadata = { connection_id: source.connection_id, external_calendar_id: source.external_calendar_id, principal: source.principal, id: source.id, summary: source.summary || source.id, accessRole: source.accessRole, timeZone: source.timeZone || 'UTC', can_edit: source.can_edit, ...(source.sync_state === 'STALE' ? { sync_state: 'STALE' } : {}) };
      const initial = { ...metadata, visible: old?.visible ?? true, sync_state: source.sync_state || 'PENDING' };
      await this.db('calendar_sources').insert({ id: hash(`${userId}:${source.id}`), userId, resource: source.id, data: JSON.stringify(initial) }).onConflict('id').merge({ data: this.db.raw('calendar_sources.data || ?::jsonb', [JSON.stringify(metadata)]), updatedAt: this.db.fn.now() });
      keep.push(source.id);
    }

    const removed = await this.db<Row<Source>>('calendar_sources').where({ userId }).whereNotIn('resource', keep);
    for (const row of removed) {
      await this.db('calendar_briefs').where({ userId }).whereRaw("resource IN (SELECT resource FROM calendar_events WHERE \"userId\" = ? AND data->>'calendar_id' = ?)", [userId, row.resource]).del();
      await this.db('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [row.resource]).del();
      await this.db('calendar_sources').where({ id: row.id, userId }).del();
    }
    return (await this.db<Row<Source>>('calendar_sources').where({ userId }).whereNot({ resource: '@connection' })).map(r => { const { sync_token, ...safe } = r.data; return safe; });
  }
  async setVisible(userId: string, calendarId: string, visible: boolean) {
    const authorized = await this.source(userId, calendarId);
    await this.db('calendar_sources').insert({ id: hash(`${userId}:${calendarId}`), userId, resource: calendarId, data: JSON.stringify({ ...authorized, visible }) }).onConflict('id').merge({ data: this.db.raw("jsonb_set(calendar_sources.data, '{visible}', ?::jsonb)", [JSON.stringify(visible)]), updatedAt: this.db.fn.now() });
  }
  private async source(userId: string, id: string, write = false, executor?: Knex) {
    await this.assertConnected(userId, executor);
    // Revalidate the provider ACL on every event read and mutation, including cached reads.
    let source: Source;
    try { source = await this.request<Source>(userId, `/users/me/calendarList/${enc(id)}`, {}, false, false, undefined, 'json', executor); }
    catch (error) {
      const cached = await this.get<Source>('calendar_sources', userId, id, executor);
      if (!write && cached && error instanceof CalendarError && error.status === 503) return { ...cached, can_edit: false, sync_state: 'STALE' };
      if (error instanceof CalendarError && [403, 404].includes(error.status)) {
        await this.purgeSourceEvidence(userId, id, executor);
        await (executor || this.db)('calendar_sources').where({ userId, resource: id }).del();
      }
      throw error;
    }
    if (!['reader', 'writer', 'owner'].includes(source.accessRole)) { await this.purgeSourceEvidence(userId, id, executor); throw new CalendarError(403, 'PERMISSION_DENIED', 'This calendar is unavailable'); }
    if (write && !['writer', 'owner'].includes(source.accessRole)) throw new CalendarError(403, 'PERMISSION_DENIED', 'This calendar is read-only or unavailable');
    const [connectionId] = parseSourceKey(id);
    const account = (await this.oauth.listCalendarAccounts(userId, executor)).find(a => a.id === connectionId);
    return { ...source, external_calendar_id: source.id, id, connection_id: connectionId, principal: account?.principal, can_edit: Boolean(account?.scopes.includes(CALENDAR_WRITE_SCOPE)) && ['writer', 'owner'].includes(source.accessRole) };
  }
  /** Current source authority also applies to safe mutation receipt replays. */
  async authorizeSource(userId: string, calendarId: string, write = false) {
    const source = await this.source(userId, calendarId, write);
    if (write && !source.can_edit) throw new CalendarError(403, 'PERMISSION_DENIED', 'Enable Google Calendar editing first');
    return source;
  }
  private expiredBriefs(executor: Knex, userId?: string) {
    const query = executor('calendar_briefs');
    if (userId) query.where({ userId });
    return query.where(builder => builder.whereRaw("data->>'expires_at' <= ?", [timestamp()]).orWhere(sub => sub.whereRaw("data->>'status' IN ('QUEUED', 'FAILED')").where('updatedAt', '<', new Date(Date.now() - 3600000))));
  }
  private expiredUnapprovedProposals(executor: Knex, userId?: string) {
    const query = executor('calendar_proposals');
    if (userId) query.where({ userId });
    return query.whereRaw("data->>'status' = 'PENDING' AND NOT jsonb_exists(data, 'approved_hash') AND data->>'expires_at' <= ?", [timestamp()]);
  }
  async maintainExpiredEvidence(userId: string, executor: Knex = this.db) {
    await this.expiredBriefs(executor, userId).del();
    await this.expiredUnapprovedProposals(executor, userId).del();
  }
  /** Independent of cached events, visible sources, grants, or provider uptime. */
  async sweepExpiredEvidence(batchSize = 250) {
    const limit = Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 1000 ? batchSize : 250;
    const briefs = this.expiredBriefs(this.db).orderBy('updatedAt').orderBy('id').limit(limit).select('id');
    await this.expiredBriefs(this.db).whereIn('id', briefs).del();
    const proposals = this.expiredUnapprovedProposals(this.db).orderBy('updatedAt').orderBy('id').limit(limit).select('id');
    // Repeat the live predicate on DELETE: a candidate that was approved after
    // selection must never lose its exact-payload retry record.
    await this.expiredUnapprovedProposals(this.db).whereIn('id', proposals).del();
  }
  /** Technical projection limits only; provider records and action receipts remain authoritative. */
  async maintainProjection(userId: string, calendarId: string, executor?: Knex) {
    const settings = calendarCacheSettings();
    const maintain = async (tx: Knex) => {
      const scoped = () => tx('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [calendarId]);
      // Older cache rows are minimized too. Provider content is never needed in
      // a cancellation marker, and repeating a hint does not renew its lifetime.
      await scoped().whereRaw("data->'event'->>'status' = 'cancelled'").update({ data: tx.raw(`jsonb_build_object('calendar_id', data->'calendar_id', 'event', jsonb_strip_nulls(jsonb_build_object('id', data->'event'->'id', 'status', 'cancelled', 'updated', data->'event'->'updated', 'etag', data->'event'->'etag', 'recurringEventId', data->'event'->'recurringEventId', 'originalStartTime', data->'event'->'originalStartTime')), 'tombstone_at', COALESCE(data->'tombstone_at', to_jsonb("updatedAt")))`) });
      await scoped().whereRaw("data->'event'->>'status' = 'cancelled'").whereRaw("(data->>'tombstone_at')::timestamptz < ?::timestamptz", [new Date(Date.now() - settings.tombstoneDays * 86400000).toISOString()]).del();
      const oldest = scoped().whereRaw("data->'event'->>'status' IS DISTINCT FROM 'cancelled'").orderBy('updatedAt', 'desc').orderBy('resource', 'asc').offset(settings.maxEvents).select('id');
      await tx('calendar_events').where({ userId }).whereIn('id', oldest).del();
      await this.maintainExpiredEvidence(userId, tx);
    };
    if (executor) await maintain(executor);
    else await this.db.transaction(async tx => { await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`calendar:${userId}:${calendarId}`]); await maintain(tx); });
  }
  private async cache(userId: string, calendarId: string, event: GoogleEvent, executor: Knex = this.db) {
    const resource = eventRef(calendarId, event.id);
    const cancelled = event.status === 'cancelled';
    const normalized: GoogleEvent = cancelled ? { id: event.id, status: 'cancelled', updated: event.updated || timestamp(), ...(event.etag ? { etag: event.etag } : {}), ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}), ...(event.originalStartTime ? { originalStartTime: event.originalStartTime } : {}) } : event;
    const data = JSON.stringify({ calendar_id: calendarId, event: normalized, ...(cancelled ? { tombstone_at: timestamp() } : {}) });
    const merged = executor.raw("CASE WHEN calendar_events.data->'event'->>'status' = 'cancelled' AND EXCLUDED.data->'event'->>'status' = 'cancelled' THEN EXCLUDED.data || jsonb_build_object('tombstone_at', COALESCE(calendar_events.data->'tombstone_at', EXCLUDED.data->'tombstone_at')) ELSE EXCLUDED.data END");
    const rows = await executor('calendar_events').insert({ id: hash(`${userId}:${resource}`), userId, resource, data }).onConflict('id').merge({ data: merged, updatedAt: executor.fn.now() }).whereRaw("COALESCE(calendar_events.data->'event'->>'updated', '') <= COALESCE(EXCLUDED.data->'event'->>'updated', '')").returning('id');
    if (rows.length) await executor('calendar_briefs').where({ userId, resource }).whereRaw("data->>'event_etag' IS DISTINCT FROM ?", [event.etag || '']).del();
  }
  async sync(userId: string, calendarId: string) {
    await this.source(userId, calendarId);
    if (!await this.get<Source>('calendar_sources', userId, calendarId)) await this.sources(userId);
    const started = performance.now();
    // A database advisory lock serializes watch, polling, and multiple app replicas.
    return this.db.transaction(async tx => {
      await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`calendar:${userId}:${calendarId}`]);
      await this.source(userId, calendarId, false, tx);
      const { rows: [{ syncStartedAt }] } = await tx.raw('SELECT clock_timestamp() AS "syncStartedAt"');
      const source = await this.get<Source>('calendar_sources', userId, calendarId, tx);
      if (!source) throw new CalendarError(404, 'NOT_FOUND', 'Calendar not found');
      let cursor = source.sync_token;
      for (let recovery = 0; recovery < 2; recovery++) {
        const changes: GoogleEvent[] = []; let page: string | undefined; let next: string | undefined;
        try {
          do {
            const query = new URLSearchParams({ maxResults: '2500', showDeleted: 'true', singleEvents: 'false' });
            if (cursor) query.set('syncToken', cursor);
            if (page) query.set('pageToken', page);
            const result = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(userId, `/calendars/${enc(calendarId)}/events?${query}`, {}, false, false, undefined, 'json', tx);
            changes.push(...result.items || []); page = result.nextPageToken; next = result.nextSyncToken;
            if (changes.length > 100000) throw new CalendarError(503, 'SYNC_LIMIT', 'Calendar is too large to sync. Contact your administrator.');
          } while (page);
          if (!next) throw new CalendarError(503, 'SYNC_INCOMPLETE', 'Google did not return a complete sync cursor');
          if (!cursor) {
            // Reconcile missing rows after a full snapshot without deleting a
            // newer direct read that completed while this collection paginated.
            const present = changes.map(event => eventRef(calendarId, event.id));
            const removed = await tx<Row>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [calendarId]).where('updatedAt', '<=', syncStartedAt).whereNotIn('resource', present);
            await tx('calendar_briefs').where({ userId }).whereIn('resource', removed.map(row => row.resource)).del();
            await tx('calendar_events').where({ userId }).whereIn('id', removed.map(row => row.id)).del();
          }
          for (const event of changes) {
            const instances = await tx<Row>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ? AND data->'event'->>'recurringEventId' = ?", [calendarId, event.id]).where('updatedAt', '<=', syncStartedAt);
            await tx('calendar_briefs').where({ userId }).whereIn('resource', instances.map(row => row.resource)).del();
            await tx('calendar_events').where({ userId }).whereIn('id', instances.map(row => row.id)).del();
            await this.cache(userId, calendarId, event, tx);
          }
          await this.maintainProjection(userId, calendarId, tx);
          await tx('calendar_sources').where({ userId, resource: calendarId }).update({ data: tx.raw('data || ?::jsonb', [JSON.stringify({ sync_token: next, last_sync_at: timestamp(), sync_state: 'HEALTHY' })]), updatedAt: tx.fn.now() });
          return;
        } catch (error) { if (error instanceof CalendarError && error.status === 410 && cursor) { calendarTelemetry.recordSignal('sync_full_resync'); cursor = undefined; continue; } throw error; }
      }
    }).then(result => { calendarTelemetry.recordSignal('sync_success', performance.now() - started); return result; }, async error => { calendarTelemetry.recordSignal('sync_failure', performance.now() - started); await this.cleanupTransactionFailure(userId, calendarId, error); throw error; });
  }
  private normalize(calendar: Source, event: GoogleEvent) {
    const readOnly = !calendar.can_edit;
    return { id: eventRef(calendar.id, event.id), kind: 'MEETING', title: event.summary || 'Busy', start: event.start?.dateTime || event.start?.date, end: event.end?.dateTime || event.end?.date, all_day: Boolean(event.start?.date), time_zone: event.start?.timeZone || calendar.timeZone,
      connection_id: calendar.connection_id, calendar_id: calendar.id, calendar_name: calendar.summary, description: event.description || '', location: event.location || '', attendees: event.attendees || [], recurrence: event.recurrence || [], recurring_event_id: event.recurringEventId,
      visibility: event.visibility || 'default', etag: event.etag, url: event.htmlLink, capabilities: { can_edit: !readOnly, can_delete: !readOnly }, sync_state: calendar.sync_state || 'HEALTHY' };
  }
  async event(userId: string, ref: string) {
    const [calendarId, id] = parseEventRef(ref);
    const source = await this.source(userId, calendarId);
    let event: GoogleEvent;
    try { event = await this.request<GoogleEvent>(userId, `/calendars/${enc(calendarId)}/events/${enc(id)}`); }
    catch (error) {
      const cached = await this.get<{ event: GoogleEvent }>('calendar_events', userId, ref);
      if (error instanceof CalendarError && error.status === 503 && cached && cached.event.status !== 'cancelled') return this.normalize({ ...source, can_edit: false, sync_state: 'STALE' }, cached.event);
      if (error instanceof CalendarError && [403, 404].includes(error.status)) {
        await this.db('calendar_events').where({ userId, resource: ref }).del();
        await this.db('calendar_briefs').where({ userId, resource: ref }).del();
        await this.db('calendar_mutations').where({ userId }).whereRaw("data->'result'->>'id' = ?", [ref]).del();
        await this.db('calendar_proposals').where({ userId }).del();
      }
      throw error;
    }
    if (event.status === 'cancelled') throw new CalendarError(404, 'NOT_FOUND', 'Meeting was cancelled');
    await this.cache(userId, calendarId, event);
    return this.normalize(source, event);
  }
  async timeline(userId: string, from: string, to: string, workspaceId?: string) {
    calendarCacheSettings();
    const items: unknown[] = [], partial: Array<{ calendar_id: string; reason: string }> = [];
    const state = await this.connection(userId);
    if (state.connected) {
      let sources: Awaited<ReturnType<CalendarService['sources']>> = [];
      try { sources = await this.sources(userId); } catch (error) { partial.push({ calendar_id: 'google', reason: error instanceof Error ? error.message : 'Google unavailable' }); }
      for (const source of sources.filter(s => s.visible)) {
        const calendarItems: unknown[] = [];
        try {
          const currentSource = await this.source(userId, source.id);
          let page: string | undefined;
          do {
            const query = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', maxResults: '2500', orderBy: 'startTime' });
            if (page) query.set('pageToken', page);
            const result = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(userId, `/calendars/${enc(source.id)}/events?${query}`);
            for (const event of result.items || []) if (event.status !== 'cancelled') { calendarItems.push(this.normalize({ ...source, ...currentSource, sync_state: 'HEALTHY' }, event)); await this.cache(userId, source.id, event); }
            page = result.nextPageToken;
          } while (page);
          // A later page can reveal revocation. Publish this source only after
          // its whole collection succeeds, never partially authorized metadata.
          items.push(...calendarItems);
          await this.maintainProjection(userId, source.id);
        } catch (error) {
          if (error instanceof CalendarError && error.status === 503) {
            const rows = await this.db<Row<{ calendar_id: string; event: GoogleEvent }>>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ?", [source.id]);
            for (const { data: { event } } of rows) {
              if (eventOverlapsRange(event, from, to, source.timeZone || 'UTC') && event.status !== 'cancelled' && !event.recurrence?.length) items.push({ ...this.normalize({ ...source, can_edit: false }, event), sync_state: 'STALE' });
            }
            partial.push({ calendar_id: source.id, reason: 'Cached data may be incomplete — Google is temporarily unavailable. Editing is disabled.' });
          } else if (error instanceof CalendarError && [401, 403, 404].includes(error.status)) {
            if (error.status !== 401) await this.purgeSourceEvidence(userId, source.id);
            if (error.status === 401) {
              for (let index = items.length - 1; index >= 0; index--) if ((items[index] as { connection_id?: string }).connection_id === source.connection_id) items.splice(index, 1);
            }
            partial.push({ calendar_id: source.id, reason: error.message });
          }
          else throw error;
        }
      }
    }
    // My Calendar aggregates only the user's own jobs across accessible workspaces.
    let jobs = this.db('workspace_schedules as s').join('workspaces as w', 'w.id', 's.workspaceId').where('s.runAsUserId', userId).where('w.status', '!=', 'trashed').where('s.nextRunAt', '>=', from).where('s.nextRunAt', '<', to).select('s.*', 'w.name as workspaceName');
    if (workspaceId) jobs = jobs.where('s.workspaceId', workspaceId);
    for (const job of await jobs) {
      const member = await this.db('workspace_members').where({ workspaceId: job.workspaceId, userId }).first();
      if (!member) continue;
      items.push({ id: `automation:${job.id}`, kind: 'AUTOMATION', title: job.name, start: job.nextRunAt, time_zone: job.timezone, status: job.status, workspace_id: job.workspaceId, workspace_name: job.workspaceName, schedule_id: job.id, capabilities: { can_edit: false, can_delete: false } });
    }
    if (this.collaboration) {
      let tasks = this.db('workspace_collaboration_objects as t').join('workspace_members as m', 'm.workspaceId', 't.workspaceId').where('m.userId', userId).where('t.type', 'task').where('t.dueAt', '>=', from).where('t.dueAt', '<', to).where(builder => builder.where('t.assigneeId', userId).orWhere(sub => sub.whereNull('t.assigneeId').where('t.authorId', userId))).select('t.*');
      if (workspaceId) tasks = tasks.where('t.workspaceId', workspaceId);
      for (const task of await tasks) {
        try {
          const { object } = await this.collaboration.getObject(task.workspaceId, task.id, userId);
          items.push({ id: `task:${task.workspaceId}:${task.id}`, kind: 'COMMITMENT', title: object.title || 'Workspace task', start: task.dueAt, status: task.status, canonical_task: true, workspace_id: task.workspaceId, task_id: task.id, capabilities: { can_edit: false, can_delete: false } });
        } catch (error) { if (!(error as { statusCode?: number })?.statusCode) throw error; }
      }
    }
    const commitments = await this.db<Row>('calendar_commitments').where({ userId });
    for (const row of commitments) if ((!workspaceId || row.data.workspace_id === workspaceId) && Date.parse(String(row.data.start)) >= Date.parse(from) && Date.parse(String(row.data.start)) < Date.parse(to)) items.push({ ...row.data, id: `commitment:${row.id}`, kind: 'COMMITMENT', capabilities: { can_edit: false, can_delete: false } });
    return { items: [...new Map(items.map(item => [(item as { id: string }).id, item])).values()], partial_sources: partial, generated_at: timestamp() };
  }
  private async audit(userId: string, action: string, resource: string, data: unknown, actorKind: 'UI' | 'AGENT' = 'UI') {
    await this.put('calendar_audit', userId, resource, { actor_kind: actorKind, action, at: timestamp(), details: data }, randomUUID());
  }
  async mutate(userId: string, method: 'POST' | 'PATCH' | 'DELETE', ref: string | undefined, input: EventInput, etag?: string, key?: string) {
    const started = performance.now();
    if (!key || !/^[\w-]{8,128}$/.test(key)) throw new CalendarError(400, 'IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key is required');
    let [calendarId, id] = ref ? parseEventRef(ref) : [input.calendar_id || '', deterministicEventId(userId, key)];
    if (!calendarId) throw new CalendarError(422, 'INVALID_EVENT', 'Choose a calendar');
    await this.source(userId, calendarId, true);
    const currentAccount = (await this.oauth.listCalendarAccounts(userId)).find(a => a.id === parseSourceKey(calendarId)[0]);
    if (!currentAccount?.scopes.includes(CALENDAR_WRITE_SCOPE)) throw new CalendarError(403, 'PERMISSION_DENIED', 'Enable Google Calendar editing first');
    const requestHash = hash(JSON.stringify({ method, ref, input, etag }));
    return this.db.transaction(async tx => {
      await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mutation:${userId}:${key}`]);
      await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`calendar:${userId}:${calendarId}`]);
      const authorizedSource = await this.source(userId, calendarId, true, tx);
      if (!authorizedSource.can_edit) throw new CalendarError(403, 'PERMISSION_DENIED', 'Enable Google Calendar editing first');
      const old = await tx<Row>('calendar_mutations').where({ userId, resource: key }).first();
      if (old) {
        if (old.data.hash !== requestHash) throw new CalendarError(409, 'IDEMPOTENCY_CONFLICT', 'This action key was already used for another change');
        calendarTelemetry.recordSignal('mutation_replayed'); return old.data.result;
      }
      let previous: GoogleEvent | undefined;
      if (method !== 'POST') {
        if (!etag) throw new CalendarError(428, 'ETAG_REQUIRED', 'Reload this meeting before making changes');
        previous = await this.request<GoogleEvent>(userId, `/calendars/${enc(calendarId)}/events/${enc(id)}`, {}, false, false, undefined, 'json', tx);
        if (input.scope === 'series' && previous.recurringEventId) {
          id = previous.recurringEventId;
          // Caller must review and provide the series ETag, never silently upgrade an occurrence ETag.
          previous = await this.request<GoogleEvent>(userId, `/calendars/${enc(calendarId)}/events/${enc(id)}`, {}, false, false, undefined, 'json', tx);
        }
        if (previous.etag !== etag) throw new CalendarError(409, 'CALENDAR_CONFLICT', 'The event or series changed. Reload the chosen scope before saving.');
      }
      const body = method === 'DELETE' ? undefined : providerBody(input, previous);
      const path = `/calendars/${enc(calendarId)}/events${method === 'POST' ? '' : `/${enc(id)}`}?sendUpdates=${input.send_updates}`;
      let result: unknown;
      try {
        const event = await this.request<GoogleEvent>(userId, path, { method, headers: etag ? { 'If-Match': etag } : {}, body: body ? JSON.stringify({ ...(method === 'POST' ? { id, extendedProperties: { private: { lumoMutationHash: requestHash } } } : {}), ...body }) : undefined }, true, false, undefined, 'json', tx);
        if (method === 'DELETE') {
          await this.cache(userId, calendarId, { id, status: 'cancelled' }, tx);
          result = { deleted: true };
        } else {
          await this.cache(userId, calendarId, event, tx);
          result = this.normalize({ ...authorizedSource, can_edit: true }, event);
        }
      } catch (error) {
        // Deterministic provider ID makes ambiguous create retries safe. Verify matching payload.
        if (method !== 'POST' || !(error instanceof CalendarError) || error.code !== 'CALENDAR_CONFLICT') throw error;
        const event = await this.request<GoogleEvent>(userId, `/calendars/${enc(calendarId)}/events/${enc(id)}`, {}, false, false, undefined, 'json', tx);
        if ((event.extendedProperties as { private?: { lumoMutationHash?: string } })?.private?.lumoMutationHash !== requestHash) throw error;
        await this.cache(userId, calendarId, event, tx);
        result = this.normalize({ ...authorizedSource, can_edit: true }, event);
      }
      await tx('calendar_mutations').insert({ id: randomUUID(), userId, resource: key, data: JSON.stringify({ hash: requestHash, result }) });
      await tx('calendar_audit').insert({ id: randomUUID(), userId, resource: ref || eventRef(calendarId, id), data: JSON.stringify({ action: method, actor_kind: 'UI', before_etag: etag, after_etag: (result as { etag?: string })?.etag, at: timestamp(), send_updates: input.send_updates, scope: input.scope }) });
      return result;
    }).then(result => { calendarTelemetry.recordSignal('mutation_success', performance.now() - started); return result; }, async error => { calendarTelemetry.recordSignal('mutation_failure', performance.now() - started); await this.cleanupTransactionFailure(userId, calendarId, error); throw error; });
  }
  private async subject(userId: string, ref: string) {
    if (ref.startsWith('meeting:')) return this.event(userId, ref);
    const [kind, id, objectId] = ref.split(':');
    if (kind === 'run' && id && !objectId) return this.runSubject(userId, id);
    if (kind === 'task' && this.collaboration && objectId) {
      const detail = await this.collaboration.getObject(id, objectId, userId);
      if (detail.object.type === 'task') return detail.object;
    }
    if (kind === 'commitment') {
      const row = await this.db<Row>('calendar_commitments').where({ userId, id }).first();
      if (row) return row.data;
    }
    if (kind === 'automation') {
      const job = await this.db('workspace_schedules').where({ id, runAsUserId: userId }).first();
      if (job && await this.db('workspace_members').where({ workspaceId: job.workspaceId, userId }).first()) return job;
    }
    throw new CalendarError(404, 'NOT_FOUND', 'Calendar subject is unavailable');
  }
  private async runSubject(userId: string, runId: string): Promise<RunSubject> {
    const read = this.runReader || (async (id: string) => (await import('./agentRunService')).getRunMeta(id));
    const run = await read(runId) || await this.db('agent_run_summaries').where({ runId }).first();
    if (!run || run.userId !== userId || !await this.db('workspace_members').where({ workspaceId: run.workspaceId, userId }).first()) throw new CalendarError(404, 'NOT_FOUND', 'Agent run is unavailable');
    return { workspaceId: run.workspaceId, userId: run.userId, status: run.status };
  }
  /** Records only server-verifiable workspace outputs, never agent assertions. */
  async linkOutput(userId: string, runRef: string, fileRef: string, meetingRef?: string) {
    const match = /^run:([^:]+)$/.exec(runRef);
    if (!match || !/^workspace:\d+$/.test(fileRef) || !this.workspaceFiles) throw new CalendarError(422, 'INVALID_OUTPUT', 'Choose a recorded workspace output and agent run');
    const run = await this.runSubject(userId, match[1]);
    if (run.status !== 'completed') throw new CalendarError(409, 'RUN_NOT_COMPLETED', 'Wait for the run to complete before linking outputs');
    const fileId = Number(fileRef.slice(10));
    const record = await this.workspaceFiles.getFileRecord(fileId, userId);
    if (record.workspaceId !== run.workspaceId) throw new CalendarError(403, 'PERMISSION_DENIED', 'Output must belong to the run’s workspace');
    const version = await this.db('file_versions as v').join('file_audit_events as a', 'a.fileVersionId', 'v.id').where({ 'v.fileId': fileId, 'v.workspaceId': run.workspaceId, 'v.sourceRunId': match[1], 'a.fileId': fileId, 'a.workspaceId': run.workspaceId, 'a.runId': match[1] }).orderBy('v.version', 'desc').select('v.id', 'v.version').first();
    if (!version) throw new CalendarError(422, 'UNVERIFIED_OUTPUT', 'No immutable file version and audit record prove this run produced the file');
    if (meetingRef) { if (!meetingRef.startsWith('meeting:')) throw new CalendarError(422, 'INVALID_EVENT_REF', 'Choose a meeting'); await this.subject(userId, meetingRef); }
    const file = await this.driveFile(userId, fileRef);
    for (const ref of [runRef, ...(meetingRef ? [meetingRef] : [])]) {
      const id = hash(`${userId}:${ref}:${fileRef}`);
      const data = { file_ref: fileRef, revision: String(version.id), output_version: String(version.id), source_run_id: match[1], provenance: 'OUTPUT', scope: 'single', created_at: timestamp() };
      const written = await this.db('calendar_links').insert({ id, userId, resource: ref, data: JSON.stringify(data) }).onConflict('id').merge({ data: JSON.stringify(data), updatedAt: this.db.fn.now() }).whereRaw("calendar_links.data->>'output_version' IS DISTINCT FROM ?", [String(version.id)]).returning('id');
      if (written.length) {
        await this.invalidateLinkBriefs(userId, ref, 'single');
        await this.audit(userId, 'link_output', ref, { source_run_id: match[1], file_ref: fileRef, output_version: String(version.id), provenance: 'OUTPUT' }, 'AGENT');
      }
    }
    return { ...file, source_run_id: match[1], output_version: String(version.id), provenance: 'OUTPUT', state: 'CONFIRMED' };
  }
  async linkRunOutputs(userId: string, runId: string) {
    const run = await this.runSubject(userId, runId);
    if (run.status !== 'completed') return;
    const outputs = await this.db('file_versions').where({ workspaceId: run.workspaceId, sourceRunId: runId }).distinct('fileId');
    for (const output of outputs) {
      try { await this.linkOutput(userId, `run:${runId}`, `workspace:${output.fileId}`); }
      catch (error) { if (!(error instanceof CalendarError && [403, 404, 422].includes(error.status)) && ![403, 404].includes((error as { statusCode: number })?.statusCode)) throw error; }
    }
  }
  async driveFile(userId: string, id: string) {
    if (id.startsWith('workspace:')) {
      if (!this.workspaceFiles || !/^workspace:\d+$/.test(id)) throw new CalendarError(404, 'NOT_FOUND', 'Workspace file unavailable');
      const file = await this.workspaceFiles.getFileRecord(Number(id.slice(10)), userId);
      return { file_ref: id, title: file.name, mime_type: file.mimeType, url: `${process.env.FRONTEND_URL || ''}/?workspaceId=${file.workspaceId}&fileId=${file.id}`, modified_at: String(file.updatedAt), revision: String(file.currentVersionId || file.version || ''), checked_at: timestamp() };
    }
    await this.assertConnected(userId);
    const [connectionId, externalId] = parseSourceKey(id);
    const data = await this.request<{ id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string; version?: string; trashed?: boolean }>(userId, `/files/${enc(externalId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,modifiedTime,version,trashed`, {}, false, true, connectionId);
    if (data.trashed) throw new CalendarError(404, 'NOT_FOUND', 'File was removed');
    return { file_ref: id, title: data.name, mime_type: data.mimeType, url: data.webViewLink, modified_at: data.modifiedTime, revision: data.version, checked_at: timestamp() };
  }
  async searchWorkspaceFiles(userId: string, workspaceId: string, q: string) {
    if (!this.workspaceFiles) return [];
    const files = await this.workspaceFiles.getFiles(workspaceId, userId);
    return files.filter(file => file.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30).map(file => ({ file_ref: `workspace:${file.id}`, title: file.name, reason: 'Workspace file · review before linking' }));
  }
  async picker(userId: string, connectionId: string) {
    await this.assertConnected(userId);
    const account = (await this.oauth.listCalendarAccounts(userId)).find(a => a.id === connectionId && a.scopes.includes(DRIVE_LINK_SCOPE));
    if (!account) throw new CalendarError(403, 'PERMISSION_DENIED', 'Enable Drive linking for this account');
    const developerKey = process.env.GOOGLE_PICKER_API_KEY, appId = process.env.GOOGLE_PICKER_APP_ID;
    if (!developerKey || !appId) throw new CalendarError(503, 'PICKER_NOT_CONFIGURED', 'Drive Picker is not configured. You can search files already available to Lumo.');
    const token = await this.oauth.getDelegatedAccessToken(userId, [DRIVE_LINK_SCOPE], true, account.id);
    return { access_token: token.accessToken, expires_at: token.expiresAt, developer_key: developerKey, app_id: appId, connection_id: account.id };
  }
  async searchFiles(userId: string, q: string, connectionIds?: string[]) {
    await this.assertConnected(userId);
    const escaped = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = new URLSearchParams({ q: `trashed = false and name contains '${escaped}'`, pageSize: '30', spaces: 'drive', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', fields: 'files(id,name,mimeType,webViewLink,modifiedTime,version)' });
    const files: unknown[] = [];
    for (const account of (await this.oauth.listCalendarAccounts(userId)).filter(a => a.scopes.includes(DRIVE_LINK_SCOPE) && (!connectionIds || connectionIds.includes(a.id)))) {
      const data = await this.request<{ files?: Array<{ id: string; name: string; webViewLink?: string; modifiedTime?: string; version?: string }> }>(userId, `/files?${query}`, {}, false, true, account.id);
      files.push(...(data.files || []).map(file => ({ file_ref: sourceKey(account.id, file.id), title: file.name, url: file.webViewLink, modified_at: file.modifiedTime, revision: file.version, state: 'SUGGESTED', reason: `Name matches your search · ${account.principal}. Review before linking.` })));
    }
    return files.slice(0, 30);
  }

  private seriesReference(ref: string, subject: LinkSubject) {
    if (!ref.startsWith('meeting:') || !subject.recurring_event_id) return undefined;
    const [calendarId] = parseEventRef(ref);
    return eventRef(calendarId, subject.recurring_event_id);
  }
  private async invalidateLinkBriefs(userId: string, ref: string, scope: LinkScope) {
    if (scope !== 'series' || !ref.startsWith('meeting:')) { await this.db('calendar_briefs').where({ userId, resource: ref }).del(); return; }
    const [calendarId, parentId] = parseEventRef(ref);
    const instances = await this.db<Row>('calendar_events').where({ userId }).whereRaw("data->>'calendar_id' = ? AND data->'event'->>'recurringEventId' = ?", [calendarId, parentId]);
    await this.db('calendar_briefs').where({ userId }).whereIn('resource', [ref, ...instances.map(instance => instance.resource)]).del();
  }
  private async suggestions(userId: string, subject: LinkSubject, excluded: Set<string>) {
    const suggestions = new Map<string, CalendarFile & { state: 'SUGGESTED'; provenance: 'EXPLICIT_SOURCE' | 'INFERRED'; reason: string }>();
    const accounts = (await this.oauth.listCalendarAccounts(userId)).filter(account => account.scopes.includes(DRIVE_LINK_SCOPE)).slice(0, 3);
    const text = `${subject.description || ''}\n${subject.location || ''}`.slice(0, 24000);
    if (this.workspaceFiles) {
      const workspaceIds = new Set([...text.matchAll(/\bworkspace:(\d{1,12})\b/g)].map(match => match[1]).slice(0, 3));
      const origins = new Set<string>();
      for (const configured of [process.env.FRONTEND_URL, process.env.GOOGLE_OAUTH_POST_LOGIN_REDIRECT]) { try { if (configured) origins.add(new URL(configured).origin); } catch { /* invalid app configuration cannot authorize a source */ } }
      for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
        if (workspaceIds.size >= 3) break;
        try { const url = new URL(match[0].replace(/&amp;/g, '&')), id = url.searchParams.get('fileId'); if (origins.has(url.origin) && id && /^\d{1,12}$/.test(id)) workspaceIds.add(id); } catch { /* malformed references are ignored */ }
      }
      for (const id of workspaceIds) {
        const fileRef = `workspace:${id}`;
        if (excluded.has(fileRef)) continue;
        try { const file = await this.driveFile(userId, fileRef); suggestions.set(fileRef, { ...file, state: 'SUGGESTED', provenance: 'EXPLICIT_SOURCE', reason: 'Referenced workspace file · review before linking' }); }
        catch (error) { if (!(error instanceof CalendarError) && !(error as { statusCode?: number })?.statusCode) throw error; }
      }
    }
    const explicitIds = new Set<string>();
    for (const match of text.matchAll(/https:\/\/(?:drive|docs)\.google\.com\/[^\s<>"']+/g)) {
      try {
        const url = new URL(match[0]);
        const id = url.pathname.match(/\/(?:file|document|spreadsheets|presentation|forms)\/d\/([\w-]+)/)?.[1] || url.searchParams.get('id');
        if (id && /^[\w-]{10,200}$/.test(id)) explicitIds.add(id);
      } catch { /* malformed references never become network destinations */ }
      if (explicitIds.size === 3) break;
    }
    // An event URL is only a candidate ID. It cannot grant Drive access.
    for (const id of explicitIds) {
      if (suggestions.size >= 3) break;
      for (const account of accounts) {
        const fileRef = sourceKey(account.id, id);
        if (excluded.has(fileRef)) break;
        try {
          const file = await this.driveFile(userId, fileRef);
          suggestions.set(fileRef, { ...file, state: 'SUGGESTED', provenance: 'EXPLICIT_SOURCE', reason: 'Referenced in meeting · review before linking' });
          break;
        } catch (error) { if (!(error instanceof CalendarError) || error.status === 401) throw error; }
      }
    }
    const title = (subject.title || subject.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (title.length >= 4 && suggestions.size < 3 && accounts.length) {
      let candidates: Awaited<ReturnType<CalendarService['searchFiles']>> = [];
      try { candidates = await this.searchFiles(userId, title, accounts.map(account => account.id)); }
      catch (error) { if (!(error instanceof CalendarError) || error.status === 401) throw error; }
      for (const candidate of candidates.slice(0, 6) as Array<{ file_ref: string }>) {
        if (excluded.has(candidate.file_ref) || suggestions.has(candidate.file_ref)) continue;
        try {
          const file = await this.driveFile(userId, candidate.file_ref);
          suggestions.set(file.file_ref, { ...file, state: 'SUGGESTED', provenance: 'INFERRED', reason: 'File name matches this item’s title · review before linking' });
        } catch (error) { if (!(error instanceof CalendarError) || error.status === 401) throw error; }
        if (suggestions.size >= 3) break;
      }
    }
    return [...suggestions.values()].slice(0, 3);
  }
  async links(userId: string, ref: string, includeSuggestions = true) {
    const subject = await this.subject(userId, ref) as LinkSubject;
    // The completion callback is best-effort; durable version provenance repairs
    // a missed association when its run context is next opened.
    if (ref.startsWith('run:')) await this.linkRunOutputs(userId, ref.slice(4));
    const parent = this.seriesReference(ref, subject);
    const rows = await this.db<Row<LinkData>>('calendar_links').where({ userId }).where(builder => {
      builder.where({ resource: ref });
      if (parent) builder.orWhere(sub => sub.where({ resource: parent }).whereRaw("data->>'scope' = 'series'"));
    });
    const confirmed = new Map<string, CalendarFile & { link_id: string; state: 'CONFIRMED'; changed: boolean; scope: LinkScope; provenance: string; inherited: boolean; source_run_id?: string; output_version?: string }>();
    // Occurrence links take precedence when the same file was also linked to the series.
    rows.sort((a, b) => Number(a.resource !== ref) - Number(b.resource !== ref));
    for (const row of rows) {
      if (row.data.state === 'DISMISSED') continue;
      if (confirmed.has(row.data.file_ref)) continue;
      try {
        const file = await this.driveFile(userId, row.data.file_ref);
        confirmed.set(file.file_ref, { ...file, link_id: row.id, state: 'CONFIRMED', changed: file.revision !== row.data.revision, scope: row.data.scope || 'single', provenance: row.data.provenance || 'MANUAL', inherited: row.resource !== ref, ...(row.data.provenance === 'OUTPUT' ? { source_run_id: row.data.source_run_id, output_version: row.data.output_version } : {}) });
      } catch (error) {
        // Fail closed: neither cached title nor URL is returned when access cannot be verified.
        if (error instanceof CalendarError || (error as { statusCode?: number })?.statusCode) { await this.db('calendar_briefs').where({ userId, resource: ref }).del(); continue; }
        throw error;
      }
    }
    const suggested = includeSuggestions ? await this.suggestions(userId, subject, new Set([...confirmed.keys(), ...rows.filter(row => row.data.state === 'DISMISSED').map(row => row.data.file_ref)])) : [];
    return { confirmed: [...confirmed.values()], suggested, personal: true, supports_series: Boolean(parent || subject.recurrence?.length) };
  }
  async link(userId: string, ref: string, fileId: string, key: string, scope: LinkScope = 'single') {
    const subject = await this.subject(userId, ref) as LinkSubject;
    const requestedRef = ref;
    if (scope === 'series') {
      const parent = this.seriesReference(ref, subject);
      if (!parent && !subject.recurrence?.length) throw new CalendarError(422, 'INVALID_LINK_SCOPE', 'Choose a recurring meeting for series-wide links');
      ref = parent || ref;
      if (parent) await this.subject(userId, parent);
    }
    const file = await this.driveFile(userId, fileId);
    const id = hash(`${userId}:${ref}:${fileId}`), requestHash = hash(JSON.stringify({ ref: requestedRef, fileId, scope })), resource = `context-link:${key}`;
    await this.db.transaction(async tx => {
      await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${userId}:${resource}`]);
      const replay = await tx<Row>('calendar_mutations').where({ userId, resource }).first();
      if (replay) {
        if (replay.data.hash !== requestHash) throw new CalendarError(409, 'IDEMPOTENCY_CONFLICT', 'This link action key was used for a different file or subject');
        return;
      }
      const existing = await tx<Row<LinkData>>('calendar_links').where({ userId, id }).first();
      const data = { file_ref: fileId, revision: file.revision, provenance: 'MANUAL', scope: existing?.data.scope === 'series' ? 'series' : scope, created_at: timestamp() };
      await tx('calendar_links').insert({ id, userId, resource: ref, data: JSON.stringify(data) }).onConflict('id').merge({ data: JSON.stringify(data), updatedAt: tx.fn.now() });
      await tx('calendar_mutations').insert({ id: randomUUID(), userId, resource, data: JSON.stringify({ hash: requestHash, link_id: id }) });
      await tx('calendar_audit').insert({ id: randomUUID(), userId, resource: ref, data: JSON.stringify({ action: 'link', actor_kind: 'UI', file_ref: fileId, at: timestamp() }) });
    });
    await this.invalidateLinkBriefs(userId, ref, scope);
    return { ...file, link_id: id, state: 'CONFIRMED', scope, provenance: 'MANUAL' };
  }

  async unlink(userId: string, id: string) {
    const row = await this.db<Row>('calendar_links').where({ userId, id }).first();
    if (!row) throw new CalendarError(404, 'NOT_FOUND', 'Link not found');
    await this.subject(userId, row.resource);
    if (row.data.provenance === 'OUTPUT') await this.db('calendar_links').where({ userId, id }).update({ data: this.db.raw("jsonb_set(data, '{state}', '\"DISMISSED\"'::jsonb)"), updatedAt: this.db.fn.now() });
    else await this.db('calendar_links').where({ userId, id }).del();
    await this.invalidateLinkBriefs(userId, row.resource, row.data.scope === 'series' ? 'series' : 'single');
  }
  private async linkedText(userId: string, file: { file_ref: string; mime_type?: string; title?: string }): Promise<{ text: string; gaps: string[] }> {
    const mime = file.mime_type || '';
    const binary = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime);
    const textFile = mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime);
    if (file.file_ref.startsWith('workspace:')) {
      if (!this.workspaceFiles || !textFile && !binary) throw new CalendarError(422, 'UNSUPPORTED_SOURCE', 'This workspace document format is unavailable for brief text extraction');
      const download = await this.workspaceFiles.getFileDownloadStream(Number(file.file_ref.slice(10)), userId);
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of download.stream) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > (binary ? 8 * 1024 * 1024 : 32000)) throw new CalendarError(422, 'SOURCE_TOO_LARGE', 'Document exceeds the briefing source size limit');
          chunks.push(bytes);
        }
      } finally { download.stream.destroy(); }
      const bytes = Buffer.concat(chunks);
      return binary ? this.documentText.read(userId, bytes, mime, file.title || 'linked-document') : { text: bytes.toString('utf8'), gaps: [] };
    }
    const [connectionId, fileId] = parseSourceKey(file.file_ref);
    if (binary) {
      const bytes = await this.request<Buffer>(userId, `/files/${enc(fileId)}?alt=media&supportsAllDrives=true`, {}, false, true, connectionId, 'binary');
      return this.documentText.read(userId, bytes, mime, file.title || 'linked-document');
    }
    const exportMime = ['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation'].includes(mime) ? 'text/plain' : mime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : undefined;
    if (!exportMime && !textFile) throw new CalendarError(422, 'UNSUPPORTED_SOURCE', 'This Drive document format is unavailable for brief text extraction');
    const text = await this.request<string>(userId, exportMime ? `/files/${enc(fileId)}/export?mimeType=${enc(exportMime)}` : `/files/${enc(fileId)}?alt=media&supportsAllDrives=true`, {}, false, true, connectionId, 'text');
    return { text, gaps: mime === 'application/vnd.google-apps.spreadsheet' ? ['Only first-sheet CSV values were reviewed. Other sheets, formulas and charts were not reviewed.'] : mime === 'application/vnd.google-apps.presentation' ? ['Only exported slide text was reviewed. Slide visuals and layout were not reviewed.'] : [] };
  }
  gmailSearch(userId: string, query: string) { return this.mail.search(userId, query); }
  private async priorOccurrence(userId: string, selected: Awaited<ReturnType<CalendarService['event']>>) {
    const [calendarId, selectedId] = parseEventRef(selected.id);
    const parentId = selected.recurring_event_id || (selected.recurrence.length ? selectedId : undefined);
    const anchor = Date.parse(selected.start || ''), lower = anchor - 7 * 86400000;
    const gaps: string[] = [];
    if (!parentId || !Number.isFinite(anchor)) return { gaps: ['No recurring occurrence with a valid start was available for prior-meeting context.'] };
    const query = new URLSearchParams({ timeMin: new Date(lower).toISOString(), timeMax: new Date(anchor).toISOString(), maxResults: '1000', showDeleted: 'false', fields: 'items(id,start,recurringEventId,status),nextPageToken' });
    try {
      // Only identifiers/times are listed. The selected prior instance alone is
      // loaded for content; no other series or calendar is searched.
      const response = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(userId, `/calendars/${enc(calendarId)}/events/${enc(parentId)}/instances?${query}`);
      if (response.nextPageToken) gaps.push('Prior-meeting search was limited to the first 1,000 instances in the previous seven days. Later pages were not reviewed.');
      const candidates = (response.items || []).slice(0, 1000).filter(item => item.id !== selectedId && item.recurringEventId === parentId && item.status !== 'cancelled' && Date.parse(item.start?.dateTime || item.start?.date || '') < anchor && Date.parse(item.start?.dateTime || item.start?.date || '') >= lower).sort((a, b) => Date.parse(b.start?.dateTime || b.start?.date || '') - Date.parse(a.start?.dateTime || a.start?.date || ''));
      if (!candidates.length) return { gaps: [...gaps, 'No prior occurrence was found in this meeting’s previous seven-day series window.'] };
      const prior = await this.event(userId, eventRef(calendarId, candidates[0].id));
      if (prior.sync_state === 'STALE' || prior.recurring_event_id !== parentId || Date.parse(prior.start || '') >= anchor || Date.parse(prior.start || '') < lower) return { gaps: [...gaps, 'The latest prior occurrence could not be verified within the selected series window and was not reviewed.'] };
      return { gaps, series_ref: eventRef(calendarId, parentId), evidence: { ref: prior.id, title: prior.title, url: prior.url, revision: prior.etag, retrieved_at: timestamp(), source: 'Google Calendar prior occurrence', text: JSON.stringify(prior).slice(0, 18000) } satisfies BriefEvidence };
    } catch (error) {
      if (error instanceof CalendarError && error.status === 401) throw error;
      if (!(error instanceof CalendarError)) throw error;
      return { gaps: [...gaps, 'Prior occurrence access or provider availability could not be verified; no previous meeting content was reviewed.'] };
    }
  }
  private async validatePrior(userId: string, selected: Awaited<ReturnType<CalendarService['event']>>, source: BriefEvidence, seriesRef: string) {
    const [calendarId, selectedId] = parseEventRef(selected.id), [priorCalendarId] = parseEventRef(source.ref);
    const parentId = selected.recurring_event_id || (selected.recurrence.length ? selectedId : undefined);
    if (!parentId || priorCalendarId !== calendarId || seriesRef !== eventRef(calendarId, parentId)) return false;
    const current = await this.event(userId, source.ref);
    return current.sync_state !== 'STALE' && current.etag === source.revision && current.recurring_event_id === parentId;
  }
  async createBrief(userId: string, ref: string, includeLinkedContent = false, gmailThreadIds: string[] = [], includePriorOccurrence = false) {
    const event = await this.event(userId, ref);
    if (event.sync_state === 'STALE') throw new CalendarError(503, 'STALE_EVENT', 'Reconnect Google before preparing a fresh briefing');
    const links = await this.links(userId, ref, false);
    const files = links.confirmed as Array<{ file_ref: string; title: string; url?: string; revision?: string; checked_at: string; mime_type?: string }>;
    const id = randomUUID();
    const started = timestamp();
    await this.put('calendar_briefs', userId, ref, { status: 'QUEUED', event_etag: event.etag, generated_at: started, include_linked_content: includeLinkedContent, include_prior_occurrence: includePriorOccurrence }, id);
    calendarTelemetry.recordSignal('brief_started');
    void (async () => {
      try {
        const gaps = ['IM was not retrieved.'];
        const evidence: BriefEvidence[] = [{ ref, title: event.title, url: event.url, retrieved_at: started, source: 'Google Calendar', text: JSON.stringify(event).slice(0, 18000), revision: event.etag }];
        const prior = includePriorOccurrence ? await this.priorOccurrence(userId, event) : undefined;
        if (prior?.evidence) evidence.push(prior.evidence);
        if (prior) gaps.push(...prior.gaps); else gaps.push('Prior occurrence context was not requested.');
        if (gmailThreadIds.length) {
          const mail = await this.mail.read(userId, gmailThreadIds);
          evidence.push(...mail.evidence); gaps.push(...mail.gaps);
        }
        if (!evidence.some(source => source.source === 'gmail')) gaps.push('Gmail was not retrieved.');
        if (!includeLinkedContent) gaps.push('Linked document content was not requested.');
        else {
          if (files.length > 5) gaps.push('Only the first five linked documents were considered.');
          for (const file of files.slice(0, 5)) {
            try {
              const { text, gaps: fileGaps } = await this.linkedText(userId, file);
              gaps.push(...fileGaps.map(gap => `${file.title}: ${gap}`));
              if (!text.trim()) { gaps.push(`${file.title}: no readable document text was available, so this file was not reviewed.`); continue; }
              evidence.push({ ref: file.file_ref, title: file.title, url: file.url, revision: file.revision, retrieved_at: timestamp(), source: file.file_ref.startsWith('workspace:') ? 'Lumo workspace' : 'Google Drive', text: text.slice(0, 12000) });
              if (text.length > 12000) gaps.push(`${file.title}: only the first 12,000 characters were reviewed.`);
            } catch { gaps.push(`${file.title}: content was unavailable or outside the supported format/size limit. It was not reviewed.`); }
          }
        }
        const sections = await this.analyzer(evidence, gaps, userId);
        const latest = await this.event(userId, ref);
        const currentLinks = await this.links(userId, ref, false);
        const current = currentLinks.confirmed as typeof files;
        if (latest.sync_state === 'STALE' || latest.etag !== event.etag || files.length !== current.length || files.some(file => !current.some(now => now.file_ref === file.file_ref && now.revision === file.revision))) throw new Error('Brief sources changed');
        if (prior?.evidence && (!prior.series_ref || !await this.validatePrior(userId, latest, prior.evidence, prior.series_ref))) throw new Error('Prior occurrence access or version changed');
        const gmailSources = evidence.filter(source => source.source === 'gmail');
        if (gmailSources.length && !await this.mail.validate(userId, gmailSources)) throw new Error('Mail source access or versions changed');
        const citations = evidence.map(({ text, ...citation }) => citation);
        await this.db('calendar_briefs').where({ userId, id }).update({ data: JSON.stringify({ status: 'READY', event_etag: event.etag, generated_at: timestamp(), expires_at: new Date(Date.now() + 3600000).toISOString(), source_fingerprint: hash(JSON.stringify(citations)), sections, citations, gmail_sources: citations.filter(source => source.source === 'gmail'), ...(prior?.evidence ? { prior_source: citations.find(source => source.ref === prior.evidence!.ref), prior_series_ref: prior.series_ref } : {}), file_versions: files.map(({ file_ref, revision }) => ({ file_ref, revision })), gaps, include_linked_content: includeLinkedContent, include_prior_occurrence: includePriorOccurrence }) });
        calendarTelemetry.recordSignal('brief_ready', Date.now() - Date.parse(started));
      } catch {
        calendarTelemetry.recordSignal('brief_failed', Date.now() - Date.parse(started));
        await this.db('calendar_briefs').where({ userId, id }).update({ data: JSON.stringify({ status: 'FAILED', error: 'Briefing could not be completed. Retry, or prepare it with the Agent.', event_etag: event.etag }) });
      }
    })();
    return { id, status: 'QUEUED' };
  }

  async brief(userId: string, id: string) {
    const row = await this.db<Row>('calendar_briefs').where({ userId, id }).first();
    if (!row) throw new CalendarError(404, 'NOT_FOUND', 'Brief is unavailable or its sources changed');
    if (row.data.expires_at && Date.parse(String(row.data.expires_at)) <= Date.now()) { await this.db('calendar_briefs').where({ userId, id }).del(); throw new CalendarError(404, 'BRIEF_EXPIRED', 'This briefing expired. Prepare a fresh briefing.'); }
    if (row.data.status === 'QUEUED' && Date.parse(String(row.data.generated_at)) < Date.now() - 120000) {
      row.data = { ...row.data, status: 'FAILED', error: 'Briefing timed out. Prepare it again.' };
      await this.db('calendar_briefs').where({ userId, id }).update({ data: JSON.stringify(row.data) });
    }
    const event = await this.event(userId, row.resource);
    const links = await this.links(userId, row.resource, false);
    const oldFiles = row.data.file_versions as Array<{ file_ref: string; revision?: string }> | undefined;
    const fresh = links.confirmed as Array<{ file_ref: string; revision?: string }>;
    if (oldFiles && (oldFiles.length !== fresh.length || oldFiles.some(file => !fresh.some(now => now.file_ref === file.file_ref && now.revision === file.revision)))) {
      await this.db('calendar_briefs').where({ userId, id }).del();
      throw new CalendarError(409, 'BRIEF_STALE', 'Brief sources changed or access was revoked. Prepare a fresh briefing.');
    }
    const gmailSources = row.data.gmail_sources as BriefEvidence[] | undefined;
    if (gmailSources?.length) {
      try { if (!await this.mail.validate(userId, gmailSources)) throw new CalendarError(409, 'BRIEF_STALE', 'Mail sources changed or access was revoked. Prepare a fresh briefing.'); }
      catch (error) { await this.db('calendar_briefs').where({ userId, id }).del(); throw error; }
    }
    if (row.data.prior_source) {
      try { if (!await this.validatePrior(userId, event, row.data.prior_source as BriefEvidence, String(row.data.prior_series_ref))) throw new CalendarError(409, 'BRIEF_STALE', 'Previous meeting context changed or access was revoked. Prepare a fresh briefing.'); }
      catch (error) { await this.db('calendar_briefs').where({ userId, id }).del(); throw error; }
    }
    return { id, ...row.data, stale: event.sync_state === 'STALE' || event.etag !== row.data.event_etag || Boolean(row.data.expires_at && Date.parse(String(row.data.expires_at)) < Date.now()) };
  }
  async commitment(userId: string, input: { title: string; start: string; workspace_id?: string; source_ref?: string; confirmed: boolean }, id?: string) {
    if (input.workspace_id && !await this.db('workspace_members').where({ workspaceId: input.workspace_id, userId }).first()) throw new CalendarError(403, 'PERMISSION_DENIED', 'Workspace is unavailable');
    if (input.source_ref) await this.subject(userId, input.source_ref);
    if (id && !await this.db('calendar_commitments').where({ userId, id }).first()) throw new CalendarError(404, 'NOT_FOUND', 'Commitment unavailable');
    const resourceId = id || randomUUID();
    await this.put('calendar_commitments', userId, resourceId, { ...input, status: input.confirmed ? 'CONFIRMED' : 'SUGGESTED', confirmed_at: input.confirmed ? timestamp() : null }, resourceId);
    return { id: `commitment:${resourceId}`, ...input };
  }
  async watch(userId: string, calendarId: string) {
    const address = process.env.CALENDAR_WEBHOOK_URL;
    if (!address || !address.startsWith('https://')) return;
    const previous = await this.get<Record<string, unknown>>('calendar_watches', userId, calendarId);
    if (previous && Number(previous.expires_at) > Date.now() + 3600000) return;
    const id = randomUUID(), token = randomUUID();
    const result = await this.request<{ resourceId: string; expiration: string }>(userId, `/calendars/${enc(calendarId)}/events/watch`, { method: 'POST', body: JSON.stringify({ id, type: 'web_hook', address, token, expiration: String(Date.now() + 6 * 86400000) }) });
    await this.put('calendar_watches', userId, calendarId, { channel_id: id, resource_id: result.resourceId, token: encryptOAuthSecret(token), expires_at: Number(result.expiration) });
    calendarTelemetry.recordSignal(previous ? 'watch_renewed' : 'watch_created');
    if (previous?.channel_id) {
      try { await this.request(userId, '/channels/stop', { method: 'POST', body: JSON.stringify({ id: previous.channel_id, resourceId: previous.resource_id }) }, false, false, parseSourceKey(calendarId)[0]); } catch { /* old channel expires */ }
    }
  }
  async notification(channel: string, resource: string, token: string) {
    const rows = await this.db<Row>('calendar_watches').whereRaw("data->>'channel_id' = ?", [channel]);
    const row = rows[0];
    if (!row || row.data.resource_id !== resource || Number(row.data.expires_at) < Date.now()) { calendarTelemetry.recordSignal('watch_hint_rejected'); throw new CalendarError(403, 'INVALID_CHANNEL', 'Unknown watch channel'); }
    const expected = Buffer.from(decryptOAuthSecret(String(row.data.token))), received = Buffer.from(token);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) { calendarTelemetry.recordSignal('watch_hint_rejected'); throw new CalendarError(403, 'INVALID_CHANNEL', 'Unknown watch channel'); }
    calendarTelemetry.recordSignal('watch_hint_accepted');
    // Persist the hint; reconciliation is durable and deduplicates repeated notifications.
    await this.db('calendar_sources').where({ userId: row.userId, resource: row.resource }).update({ data: this.db.raw("jsonb_set(data, '{sync_state}', '\"PENDING\"')") });
  }
  start() {
    const run = async () => {
      await this.sweepExpiredEvidence();
      const partitions = await this.db('calendar_events').distinct('userId', this.db.raw("data->>'calendar_id' AS calendar_id"));
      for (const partition of partitions) if (partition.calendar_id) await this.maintainProjection(partition.userId, partition.calendar_id);
      const rows = await this.db<Row<Source>>('calendar_sources').whereNot({ resource: '@connection' });
      calendarTelemetry.recordSyncHealth({ sources: rows.length, pending: rows.filter(row => row.data.sync_state === 'PENDING').length, stale: rows.filter(row => row.data.sync_state === 'STALE').length, reauth: rows.filter(row => row.data.sync_state === 'REAUTH_REQUIRED').length, maxCursorAgeMs: Math.max(0, ...rows.map(row => row.data.last_sync_at ? Date.now() - Date.parse(row.data.last_sync_at) : 0)) });
      for (const row of rows) {
        if (!row.data.visible) continue;
        try {
          if (row.data.sync_state === 'PENDING' || !row.data.last_sync_at || Date.parse(row.data.last_sync_at) < Date.now() - 120000) await this.sync(row.userId, row.resource);
          await this.watch(row.userId, row.resource);
        } catch (error) {
          await this.db('calendar_sources').where({ id: row.id }).update({ data: this.db.raw("jsonb_set(data, '{sync_state}', ?::jsonb)", [JSON.stringify(error instanceof CalendarError && error.status === 401 ? 'REAUTH_REQUIRED' : 'STALE')]) });
        }
      }
    };
    let busy = false;
    this.timer = setInterval(() => { if (busy) return; busy = true; void run().catch(() => console.error('Calendar reconciliation failed')).finally(() => { busy = false; }); }, 30000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}
