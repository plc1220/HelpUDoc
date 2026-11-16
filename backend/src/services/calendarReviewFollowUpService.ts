import { createHash, randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { CalendarError, parseEventRef } from './calendarModel';
import type { CalendarService } from './calendarService';
import type { WorkspaceService } from './workspaceService';
import type { WorkspaceCollaborationService } from './workspaceCollaborationService';
import { canPostWorkspaceTeamMessage } from './workspaceCollaborationPolicy';
import { WorkspaceTeamThreadStore } from './workspaceTeamThreadStore';
import { isInternalWorkspacePath } from '../lib/workspacePaths';

const RULES = 'calendar_review_follow_up_rules';
const AUDIT = 'calendar_review_follow_up_audit';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const reviewFollowUpInput = z.object({
  event_ref: z.string().min(1).max(4096),
  workspace_id: z.uuid(),
  file_path: z.string().trim().min(1).max(1024),
  thread_id: z.uuid(),
  lead_minutes: z.number().int().min(1).max(10080),
}).strict();
export type ReviewFollowUpInput = z.infer<typeof reviewFollowUpInput>;
export type ReviewFollowUpRule = ReviewFollowUpInput & {
  id: string; user_id: string; file_id: number; enabled: boolean;
  last_event_start: string | null; last_error: string | null;
  created_at: Date | string; updated_at: Date | string;
};

/** Separate durable storage: calendar caches and provider grants can be purged
 * without losing the evidence that an occurrence already produced a post. */
export async function ensureCalendarReviewFollowUpSchema(db: Knex) {
  if (!await db.schema.hasTable(RULES)) {
    await db.schema.createTable(RULES, t => {
      t.uuid('id').primary();
      t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
      t.text('event_ref').notNullable(); t.text('file_path').notNullable();
      t.integer('file_id').notNullable(); t.uuid('thread_id').notNullable();
      t.integer('lead_minutes').notNullable(); t.boolean('enabled').notNullable().defaultTo(true);
      t.text('last_event_start'); t.text('last_error');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
      t.index(['user_id']); t.index(['enabled', 'updated_at']);
    });
  }
  if (!await db.schema.hasTable(AUDIT)) {
    await db.schema.createTable(AUDIT, t => {
      t.uuid('id').primary();
      t.uuid('rule_id').notNullable().references('id').inTable(RULES).onDelete('CASCADE');
      t.string('occurrence_key', 64).notNullable(); t.string('outcome', 32).notNullable();
      t.uuid('message_id'); t.text('event_start');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
      t.unique(['rule_id', 'occurrence_key']);
    });
  }
}

/** One explicitly selected Google occurrence and one internal thread. No agent
 * tools, mail transport or Calendar mutation interface is available here. */
export class CalendarReviewFollowUpService {
  private readonly threads: WorkspaceTeamThreadStore;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly db: Knex,
    private readonly calendar: Pick<CalendarService, 'event'>,
    private readonly workspace: Pick<WorkspaceService, 'ensureMembership'>,
    private readonly collaboration: Pick<WorkspaceCollaborationService, 'getThread'>,
    private readonly clock: () => Date = () => new Date(),
  ) { this.threads = new WorkspaceTeamThreadStore(db); }

  start() {
    if (this.timer) return;
    const poll = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.tick(); } catch { /* Durable rules remain available for the next poll. */ }
      finally { this.running = false; }
    };
    this.timer = setInterval(() => { void poll(); }, 30_000);
    this.timer.unref();
    void poll();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async authorize(userId: string, input: ReviewFollowUpInput) {
    const user = await this.db('users').where({ id: userId }).first();
    if (!user || (user.status && user.status !== 'active')) {
      throw new CalendarError(403, 'FOLLOW_UP_DENIED', 'An active user is required');
    }
    const access = await this.workspace.ensureMembership(input.workspace_id, userId);
    if (access.workspace.visibility !== 'team' || !['active', undefined, null].includes(access.workspace.status)
      || !canPostWorkspaceTeamMessage(access.membership.role)) {
      throw new CalendarError(403, 'FOLLOW_UP_DENIED', 'Commenter access to an active Shared workspace is required');
    }
    await this.collaboration.getThread(input.workspace_id, input.thread_id, userId);
  }

  private eventStart(event: Awaited<ReturnType<CalendarService['event']>>) {
    if (event.sync_state !== 'HEALTHY') throw new CalendarError(503, 'FOLLOW_UP_STALE', 'A fresh calendar read is required');
    if (event.all_day || event.recurrence?.length || !event.start || !/(Z|[+-]\d\d:\d\d)$/.test(event.start)
      || !Number.isFinite(Date.parse(event.start))) {
      throw new CalendarError(422, 'FOLLOW_UP_EVENT_INVALID', 'Choose one timed meeting occurrence');
    }
    return Date.parse(event.start);
  }

  async create(userId: string, value: ReviewFollowUpInput): Promise<ReviewFollowUpRule> {
    const input = reviewFollowUpInput.parse(value);
    parseEventRef(input.event_ref);
    input.file_path = input.file_path.replace(/^\/+/, '');
    if (input.file_path.split(/[\\/]/).some(part => part === '..') || isInternalWorkspacePath(input.file_path)) {
      throw new CalendarError(422, 'FOLLOW_UP_FILE_INVALID', 'Choose a shared workspace artifact');
    }
    await this.authorize(userId, input);
    const event = await this.calendar.event(userId, input.event_ref);
    if (this.eventStart(event) <= this.clock().getTime()) throw new CalendarError(422, 'FOLLOW_UP_EVENT_PAST', 'Choose a future meeting');
    const file = await this.db('files').where({ workspaceId: input.workspace_id, name: input.file_path }).whereNull('deletedAt').first();
    if (!file) throw new CalendarError(404, 'FOLLOW_UP_FILE_MISSING', 'Shared artifact not found');
    const now = this.clock();
    const rule = { ...input, id: randomUUID(), user_id: userId, file_id: Number(file.id), enabled: true,
      last_event_start: event.start!, last_error: null, created_at: now, updated_at: now };
    await this.db(RULES).insert(rule);
    return rule;
  }

  list(userId: string, eventRef?: string): Promise<ReviewFollowUpRule[]> {
    return this.db(RULES).where({ user_id: userId }).modify(q => { if (eventRef) q.where({ event_ref: eventRef }); }).orderBy('created_at', 'desc');
  }

  async disable(userId: string, id: string) {
    const count = await this.db(RULES).where({ id, user_id: userId }).update({ enabled: false, updated_at: this.clock() });
    if (!count) throw new CalendarError(404, 'FOLLOW_UP_MISSING', 'Follow-up rule not found');
    return { ok: true };
  }

  async audit(userId: string, id: string) {
    const rule = await this.db(RULES).where({ id, user_id: userId }).first();
    if (!rule) throw new CalendarError(404, 'FOLLOW_UP_MISSING', 'Follow-up rule not found');
    return this.db(AUDIT).where({ rule_id: id }).orderBy('created_at', 'desc').limit(100);
  }

  /** Durable rules are the queue. Lock a rule before provider validation and keep
   * its post and final audit in the same transaction; a crash rolls back both.
   * No lease or in-memory delivery marker can cause a lost/duplicate post. */
  async tick() {
    const rules = await this.db(RULES).where({ enabled: true }).orderBy('updated_at', 'asc').limit(100).select('id');
    for (const { id } of rules) await this.process(id);
  }

  private async process(id: string) {
    try {
      await this.db.transaction(async tx => {
        const rule = await tx<ReviewFollowUpRule>(RULES).where({ id, enabled: true }).forUpdate().skipLocked().first();
        if (!rule) return;
        const occurrenceKey = digest(rule.event_ref);
        if (await tx(AUDIT).where({ rule_id: id, occurrence_key: occurrenceKey }).first()) return;
        let eventStart: string | null = rule.last_event_start;
        const finish = async (outcome: string, messageId: string | null = null) => {
          await tx(AUDIT).insert({ id: randomUUID(), rule_id: id, occurrence_key: occurrenceKey, outcome,
            message_id: messageId, event_start: eventStart, created_at: this.clock() });
          await tx(RULES).where({ id }).update({ enabled: false, last_error: null, last_event_start: eventStart, updated_at: this.clock() });
        };
        let event: Awaited<ReturnType<CalendarService['event']>>;
        try {
          await this.authorize(rule.user_id, rule);
          event = await this.calendar.event(rule.user_id, rule.event_ref);
        } catch (error) {
          const status = Number((error as { status?: number; statusCode?: number }).status || (error as { statusCode?: number }).statusCode);
          if ([401, 403, 404, 410].includes(status)) { await finish(status === 404 || status === 410 ? 'cancelled' : 'blocked'); return; }
          throw error;
        }
        let startsAt: number;
        try { startsAt = this.eventStart(event); }
        catch (error) { if (error instanceof CalendarError && error.status === 422) { await finish('blocked'); return; } throw error; }
        eventStart = event.start!;
        const now = this.clock().getTime();
        if (startsAt <= now) { await finish('expired'); return; }
        if (startsAt - rule.lead_minutes * 60_000 > now) {
          await tx(RULES).where({ id }).update({ last_event_start: eventStart, last_error: null, updated_at: this.clock() });
          return;
        }
        // Bind by stable file identity too: deletion/recreation or rename must
        // not silently redirect a previously approved rule to another artifact.
        const file = await tx('files').where({ id: rule.file_id, workspaceId: rule.workspace_id, name: rule.file_path }).whereNull('deletedAt').forShare().first();
        if (!file) { await finish('blocked'); return; }
        const pending = await tx('workspace_collaboration_objects')
          .where({ workspaceId: rule.workspace_id, visibility: 'workspace_audience' })
          .whereIn('type', ['annotation', 'change_proposal', 'task'])
          .whereIn('status', ['open', 'discussing', 'proposed', 'anchor_changed'])
          .where(q => q.where('fileId', rule.file_id).orWhere(q2 => q2.whereNull('fileId').whereIn('filePath', [rule.file_path, `/${rule.file_path}`])))
          .orderBy('id').limit(51).forShare().select('id', 'type', 'title', 'body', 'status');
        if (!pending.length) { await finish('no_pending'); return; }
        // Recheck authorization immediately before appending; summaries include
        // only shared review labels, never event title/attendees/private drafts.
        try {
          await this.authorize(rule.user_id, rule);
          const current = await this.calendar.event(rule.user_id, rule.event_ref);
          const currentStart = this.eventStart(current);
          if (currentStart <= this.clock().getTime()) { await finish('expired'); return; }
          if (current.start !== eventStart || current.etag !== event.etag) {
            await tx(RULES).where({ id }).update({ last_event_start: current.start, last_error: null, updated_at: this.clock() });
            return;
          }
        } catch (error) {
          const status = Number((error as { status?: number; statusCode?: number }).status || (error as { statusCode?: number }).statusCode);
          if ([401, 403, 404, 410, 422].includes(status)) { await finish([404, 410].includes(status) ? 'cancelled' : 'blocked'); return; }
          throw error;
        }
        const items = pending.slice(0, 50).map(item => {
          const label = String(item.title?.trim() || item.body?.trim() || item.type)
            .replace(/\s+/g, ' ').slice(0, 200)
            .replace(/[\\`*_{}\[\]()<>!#|~]/g, '\\$&');
          return `- ${label} (${item.status})`;
        });
        const body = [`Calendar review follow-up: ${rule.file_path}`, `Review starts ${eventStart}. Pending shared review items:`, ...items,
          ...(pending.length > 50 ? ['- More pending items are available on the artifact.'] : [])].join('\n');
        const message = await this.threads.appendMessage(tx, {
          workspaceId: rule.workspace_id, threadId: rule.thread_id, authorId: null, authorType: 'lumo', body,
          originVersionId: null, mentionsLumo: false,
          metadata: { kind: 'calendar_review_follow_up', ruleId: id, occurrenceKey, requestedBy: rule.user_id,
            filePath: rule.file_path, pendingObjectIds: pending.slice(0, 50).map(item => item.id) },
        });
        await finish('posted', message.id);
      });
    } catch (error) {
      // Transient/provider failures leave the rule retryable. Content-free codes
      // are durable, while payloads and credentials never enter this record.
      const code = error instanceof CalendarError ? error.code : 'FOLLOW_UP_RETRY';
      await this.db(RULES).where({ id, enabled: true }).update({ last_error: code, updated_at: this.clock() });
    }
  }
}
