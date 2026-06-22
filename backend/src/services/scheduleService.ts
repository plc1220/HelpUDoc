import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { ConversationService, type ConversationRecord } from './conversationService';
import { GoogleOAuthService } from './googleOAuthService';
import { UserService } from './userService';
import { getRunMeta, startAgentRun, type AgentRunStatus } from './agentRunService';
import { createAgentPolicyApi } from '../api/agent/policy';
import { NotFoundError } from '../errors';
import type {
  FileContextRef,
  WorkspaceSchedule,
  WorkspaceScheduleCadence,
  WorkspaceScheduleDraft,
  WorkspaceScheduleNotificationMode,
  WorkspaceScheduleOutputMode,
  WorkspaceScheduleRun,
  WorkspaceScheduleRunStatus,
  WorkspaceScheduleStatus,
} from '@helpudoc/contracts/types';

type WorkspaceScheduleRow = Omit<
  WorkspaceSchedule,
  | 'recentRuns'
  | 'selectedSkills'
  | 'contextRefs'
  | 'taggedFiles'
  | 'fileContextRefs'
  | 'nextRunAt'
  | 'lastRunAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  selectedSkills: unknown;
  contextRefs: unknown;
  taggedFiles: unknown;
  fileContextRefs: unknown;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type WorkspaceScheduleRunRow = Omit<
  WorkspaceScheduleRun,
  'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'
> & {
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type ScheduleUpdatePayload = Partial<WorkspaceScheduleDraft> & {
  status?: WorkspaceScheduleStatus;
};

type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
};

const SCHEDULER_POLL_INTERVAL_MS = 30_000;
const SCHEDULE_LOCK_TIMEOUT_MINUTES = 15;
const MAX_DUE_SCHEDULES_PER_TICK = 10;
const MAX_IN_FLIGHT_RUNS_PER_TICK = 25;
const CRON_SEARCH_LIMIT_MINUTES = 366 * 24 * 60 * 2;
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_PERSONA = 'fast';
const SCHEDULER_ID = `scheduler-${process.pid}-${randomUUID().slice(0, 8)}`;

const ensureTimezone = (timezone?: string | null): string => {
  const value = String(timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error(`Invalid timezone "${value}"`);
  }
};

const parseCronPart = (
  raw: string,
  min: number,
  max: number,
  options: { allowSevenAsSunday?: boolean } = {},
): Set<number> => {
  const values = new Set<number>();
  const addValue = (candidate: number) => {
    const normalized = options.allowSevenAsSunday && candidate === 7 ? 0 : candidate;
    if (normalized < min || normalized > max) {
      throw new Error(`Cron value ${candidate} is outside ${min}-${max}`);
    }
    values.add(normalized);
  };

  raw.split(',').forEach((segment) => {
    const part = segment.trim();
    if (!part) {
      throw new Error('Cron fields cannot contain empty segments');
    }
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${stepPart}"`);
    }

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const rangeMatch = rangePart.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        start = Number(rangeMatch[1]);
        end = Number(rangeMatch[2]);
      } else if (/^\d+$/.test(rangePart)) {
        start = Number(rangePart);
        end = Number(rangePart);
      } else {
        throw new Error(`Invalid cron field "${part}"`);
      }
    }
    if (start > end) {
      throw new Error(`Invalid cron range "${part}"`);
    }
    for (let value = start; value <= end; value += step) {
      addValue(value);
    }
  });

  if (!values.size) {
    throw new Error('Cron field did not produce any values');
  }
  return values;
};

export const parseCronExpression = (expression: string): ParsedCron => {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  }
  return {
    minute: parseCronPart(fields[0], 0, 59),
    hour: parseCronPart(fields[1], 0, 23),
    dayOfMonth: parseCronPart(fields[2], 1, 31),
    month: parseCronPart(fields[3], 1, 12),
    dayOfWeek: parseCronPart(fields[4], 0, 6, { allowSevenAsSunday: true }),
  };
};

const getLocalDateParts = (date: Date, timezone: string) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, dayOfWeek };
};

const matchesCron = (date: Date, timezone: string, parsed: ParsedCron): boolean => {
  const parts = getLocalDateParts(date, timezone);
  return (
    parsed.minute.has(parts.minute) &&
    parsed.hour.has(parts.hour) &&
    parsed.dayOfMonth.has(parts.day) &&
    parsed.month.has(parts.month) &&
    parsed.dayOfWeek.has(parts.dayOfWeek)
  );
};

export const computeNextRunAt = (
  cronExpression: string,
  timezone: string,
  after: Date = new Date(),
): Date => {
  const parsed = parseCronExpression(cronExpression);
  const resolvedTimezone = ensureTimezone(timezone);
  const startMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < CRON_SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = new Date(startMs + offset * 60_000);
    if (matchesCron(candidate, resolvedTimezone, parsed)) {
      return candidate;
    }
  }
  throw new Error('Cron expression did not produce a run time in the next two years');
};

const toJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toIsoOrNull = (value: unknown): string | null => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeStringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
    : []
);

const normalizePrompt = (value: string): string => {
  const prompt = String(value || '').trim();
  if (!prompt) {
    throw new Error('Schedule prompt cannot be empty');
  }
  return prompt;
};

const buildAgentPrompt = (schedule: WorkspaceScheduleRow): string => {
  const rawPrompt = normalizePrompt(schedule.prompt);
  const skillMatch = rawPrompt.match(/^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
  const selectedSkills = normalizeStringArray(schedule.selectedSkills);
  const skillId = skillMatch?.[1]?.trim() || selectedSkills[0];
  if (!skillId) {
    return rawPrompt;
  }
  const prompt = skillMatch ? (skillMatch[2] || '').trim() : rawPrompt;
  return [
    '<<<HELPUDOC_DIRECTIVE',
    JSON.stringify({ kind: 'skill', skillId }),
    '>>>',
    prompt || 'Continue with the selected skill.',
  ].join('\n');
};

const titleFromScheduleName = (name: string): string => {
  const trimmed = name.trim();
  const title = trimmed ? `Scheduled: ${trimmed}` : 'Scheduled run';
  return title.length > 255 ? title.slice(0, 255) : title;
};

export class ScheduleService {
  private db: Knex;
  private workspaceService: WorkspaceService;
  private conversationService: ConversationService;
  private userService: UserService;
  private googleOAuthService: GoogleOAuthService;
  private interval?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    databaseService: DatabaseService,
    workspaceService: WorkspaceService,
    conversationService: ConversationService,
    userService: UserService,
    googleOAuthService: GoogleOAuthService,
  ) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.conversationService = conversationService;
    this.userService = userService;
    this.googleOAuthService = googleOAuthService;
  }

  startScheduler(): void {
    if (this.interval) {
      return;
    }
    const tick = () => {
      void this.tick().catch((error) => {
        console.error('Scheduled job tick failed', error);
      });
    };
    const initial = setTimeout(tick, 5_000);
    initial.unref?.();
    this.interval = setInterval(tick, SCHEDULER_POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  stopScheduler(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async listSchedulesForWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSchedule[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const rows = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .where({ workspaceId })
      .orderBy('createdAt', 'desc');
    const schedules = rows.map((row) => this.serializeSchedule(row));
    await Promise.all(
      schedules.map(async (schedule) => {
        schedule.recentRuns = await this.listRunsForSchedule(userId, workspaceId, schedule.id, 5);
      }),
    );
    return schedules;
  }

  async getSchedule(userId: string, workspaceId: string, scheduleId: string): Promise<WorkspaceSchedule> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const row = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .where({ id: scheduleId, workspaceId })
      .first();
    if (!row) {
      throw new NotFoundError('Schedule not found');
    }
    const schedule = this.serializeSchedule(row);
    schedule.recentRuns = await this.listRunsForSchedule(userId, workspaceId, scheduleId, 10);
    return schedule;
  }

  async createSchedule(userId: string, workspaceId: string, payload: WorkspaceScheduleDraft): Promise<WorkspaceSchedule> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    if (payload.sourceConversationId) {
      await this.conversationService.ensureConversationAccess(userId, workspaceId, payload.sourceConversationId);
    }
    if (payload.targetConversationId) {
      await this.conversationService.ensureConversationAccess(userId, workspaceId, payload.targetConversationId);
    }

    const timezone = ensureTimezone(payload.timezone);
    const cronExpression = String(payload.cronExpression || DEFAULT_CRON).trim();
    const nextRunAt = computeNextRunAt(cronExpression, timezone);
    const [row] = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .insert({
        id: randomUUID(),
        workspaceId,
        createdBy: userId,
        runAsUserId: userId,
        sourceConversationId: payload.sourceConversationId || null,
        sourceMessageId: payload.sourceMessageId || null,
        targetConversationId: payload.targetConversationId || null,
        name: payload.name.trim() || 'Scheduled run',
        status: 'active',
        cadence: payload.cadence || 'daily',
        cronExpression,
        timezone,
        prompt: normalizePrompt(payload.prompt),
        persona: payload.persona || DEFAULT_PERSONA,
        selectedSkills: JSON.stringify(normalizeStringArray(payload.selectedSkills)),
        contextRefs: JSON.stringify(normalizeStringArray(payload.contextRefs)),
        taggedFiles: JSON.stringify(normalizeStringArray(payload.taggedFiles)),
        fileContextRefs: JSON.stringify(toJsonArray<FileContextRef>(payload.fileContextRefs)),
        outputMode: payload.outputMode || 'append_to_conversation',
        notificationMode: payload.notificationMode || 'none',
        nextRunAt: nextRunAt.toISOString(),
      })
      .returning('*');

    await this.workspaceService.touchWorkspace(workspaceId, userId);
    return this.serializeSchedule(row);
  }

  async updateSchedule(
    userId: string,
    workspaceId: string,
    scheduleId: string,
    payload: ScheduleUpdatePayload,
  ): Promise<WorkspaceSchedule> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const existing = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .where({ id: scheduleId, workspaceId })
      .first();
    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }
    if (payload.sourceConversationId) {
      await this.conversationService.ensureConversationAccess(userId, workspaceId, payload.sourceConversationId);
    }
    if (payload.targetConversationId) {
      await this.conversationService.ensureConversationAccess(userId, workspaceId, payload.targetConversationId);
    }

    const update: Record<string, unknown> = {
      updatedAt: this.db.fn.now(),
      lockedAt: null,
      lockedBy: null,
    };
    if (payload.name !== undefined) update.name = payload.name.trim() || existing.name;
    if (payload.status !== undefined) update.status = payload.status;
    if (payload.cadence !== undefined) update.cadence = payload.cadence;
    if (payload.cronExpression !== undefined) update.cronExpression = payload.cronExpression.trim();
    if (payload.timezone !== undefined) update.timezone = ensureTimezone(payload.timezone);
    if (payload.prompt !== undefined) update.prompt = normalizePrompt(payload.prompt);
    if (payload.persona !== undefined) update.persona = payload.persona || DEFAULT_PERSONA;
    if (payload.selectedSkills !== undefined) update.selectedSkills = JSON.stringify(normalizeStringArray(payload.selectedSkills));
    if (payload.contextRefs !== undefined) update.contextRefs = JSON.stringify(normalizeStringArray(payload.contextRefs));
    if (payload.taggedFiles !== undefined) update.taggedFiles = JSON.stringify(normalizeStringArray(payload.taggedFiles));
    if (payload.fileContextRefs !== undefined) update.fileContextRefs = JSON.stringify(toJsonArray<FileContextRef>(payload.fileContextRefs));
    if (payload.outputMode !== undefined) update.outputMode = payload.outputMode;
    if (payload.notificationMode !== undefined) update.notificationMode = payload.notificationMode;
    if (payload.sourceConversationId !== undefined) update.sourceConversationId = payload.sourceConversationId || null;
    if (payload.sourceMessageId !== undefined) update.sourceMessageId = payload.sourceMessageId || null;
    if (payload.targetConversationId !== undefined) update.targetConversationId = payload.targetConversationId || null;

    const nextStatus = (update.status as WorkspaceScheduleStatus | undefined) || existing.status;
    const nextCron = String(update.cronExpression || existing.cronExpression);
    const nextTimezone = String(update.timezone || existing.timezone || DEFAULT_TIMEZONE);
    const cadenceChanged = payload.cronExpression !== undefined || payload.timezone !== undefined || payload.status === 'active';
    if (nextStatus === 'active' && cadenceChanged) {
      update.nextRunAt = computeNextRunAt(nextCron, nextTimezone);
      update.lastError = null;
    }

    const [row] = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .where({ id: scheduleId, workspaceId })
      .update(update)
      .returning('*');
    await this.workspaceService.touchWorkspace(workspaceId, userId);
    return this.serializeSchedule(row);
  }

  async deleteSchedule(userId: string, workspaceId: string, scheduleId: string): Promise<boolean> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const deleted = await this.db('workspace_schedules').where({ id: scheduleId, workspaceId }).del();
    if (deleted) {
      await this.workspaceService.touchWorkspace(workspaceId, userId);
    }
    return deleted > 0;
  }

  async listRunsForSchedule(
    userId: string,
    workspaceId: string,
    scheduleId: string,
    limit = 20,
  ): Promise<WorkspaceScheduleRun[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const rows = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
      .where({ scheduleId, workspaceId })
      .orderBy('createdAt', 'desc')
      .limit(limit);
    return rows.map((row) => this.serializeRun(row));
  }

  async triggerScheduleNow(userId: string, workspaceId: string, scheduleId: string): Promise<WorkspaceScheduleRun> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const schedule = await this.db<WorkspaceScheduleRow>('workspace_schedules')
      .where({ id: scheduleId, workspaceId })
      .first();
    if (!schedule) {
      throw new NotFoundError('Schedule not found');
    }
    return this.executeSchedule(schedule, 'manual', { updateNextRunAt: false, overrideUserId: userId });
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.refreshInFlightRuns();
      const dueSchedules = await this.claimDueSchedules();
      for (const schedule of dueSchedules) {
        await this.executeSchedule(schedule, 'scheduler', { updateNextRunAt: true }).catch(async (error) => {
          const message = error instanceof Error ? error.message : 'Scheduled run failed to start';
          await this.pauseScheduleForError(schedule, message);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claimDueSchedules(): Promise<WorkspaceScheduleRow[]> {
    return this.db.transaction(async (trx) => {
      const query = trx<WorkspaceScheduleRow>('workspace_schedules')
        .where({ status: 'active' })
        .whereNotNull('nextRunAt')
        .andWhere('nextRunAt', '<=', trx.fn.now())
        .andWhere((builder) => {
          builder
            .whereNull('lockedAt')
            .orWhere('lockedAt', '<', trx.raw(`now() - interval '${SCHEDULE_LOCK_TIMEOUT_MINUTES} minutes'`));
        })
        .orderBy('nextRunAt', 'asc')
        .limit(MAX_DUE_SCHEDULES_PER_TICK)
        .forUpdate();
      const rows = await (query as any).skipLocked();
      if (!rows.length) {
        return [];
      }
      const ids = (rows as WorkspaceScheduleRow[]).map((row) => row.id);
      await trx('workspace_schedules')
        .whereIn('id', ids)
        .update({
          lockedAt: trx.fn.now(),
          lockedBy: SCHEDULER_ID,
          updatedAt: trx.fn.now(),
        });
      return rows as WorkspaceScheduleRow[];
    });
  }

  private async executeSchedule(
    schedule: WorkspaceScheduleRow,
    triggeredBy: 'scheduler' | 'manual',
    options: { updateNextRunAt: boolean; overrideUserId?: string },
  ): Promise<WorkspaceScheduleRun> {
    const scheduleRunId = randomUUID();
    const runAsUserId = options.overrideUserId || schedule.runAsUserId || schedule.createdBy || '';
    const startedAt = new Date();
    let scheduleRun: WorkspaceScheduleRunRow | null = null;

    try {
      if (!runAsUserId) {
        throw new Error('The schedule no longer has a valid user to run as');
      }
      await this.workspaceService.ensureMembership(schedule.workspaceId, runAsUserId, { requireEdit: true });
      const conversation = await this.resolveOutputConversation(schedule, runAsUserId, triggeredBy);
      const turnId = `schedule-${schedule.id}-${scheduleRunId}`;
      const prompt = normalizePrompt(schedule.prompt);
      await this.conversationService.appendMessage(
        runAsUserId,
        conversation.id,
        'user',
        prompt,
        {
          turnId,
          metadata: {
            scheduleId: schedule.id,
            scheduleRunId,
            sourceConversationId: schedule.sourceConversationId || undefined,
            sourceMessageId: schedule.sourceMessageId || undefined,
          },
        },
      );

      const [runRow] = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
        .insert({
          id: scheduleRunId,
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          conversationId: conversation.id,
          status: 'queued',
          triggeredBy,
          startedAt: startedAt.toISOString(),
        })
        .returning('*');
      scheduleRun = runRow;

      const policyApi = createAgentPolicyApi(this.googleOAuthService, this.userService);
      const workspacePolicy = await this.workspaceService.getMcpServerPolicy(schedule.workspaceId, runAsUserId, { requireEdit: true });
      const policy = await policyApi.resolveEffectiveAgentPolicy(runAsUserId, workspacePolicy);
      const authToken = await policyApi.buildAgentAuthToken({
        userId: runAsUserId,
        workspaceId: schedule.workspaceId,
        policy,
      });
      const agentPrompt = buildAgentPrompt(schedule);
      const { runId } = await startAgentRun({
        workspaceId: schedule.workspaceId,
        conversationId: conversation.id,
        userId: runAsUserId,
        persona: schedule.persona || DEFAULT_PERSONA,
        prompt: agentPrompt,
        history: [],
        forceReset: true,
        turnId,
        authToken: authToken || undefined,
        fileContextRefs: toJsonArray<FileContextRef>(schedule.fileContextRefs),
      });

      const nextRunAt = options.updateNextRunAt
        ? computeNextRunAt(schedule.cronExpression, schedule.timezone, new Date())
        : schedule.nextRunAt;
      const [updatedRun] = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
        .where({ id: scheduleRunId })
        .update({
          agentRunId: runId,
          status: 'running',
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      await this.db('workspace_schedules')
        .where({ id: schedule.id })
        .update({
          targetConversationId:
            schedule.outputMode === 'append_to_conversation'
              ? conversation.id
              : schedule.targetConversationId || null,
          nextRunAt,
          lastRunAt: startedAt,
          lastRunStatus: 'running',
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          updatedAt: this.db.fn.now(),
        });
      return this.serializeRun(updatedRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scheduled run failed to start';
      if (scheduleRun) {
        const [failedRun] = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
          .where({ id: scheduleRunId })
          .update({
            status: 'failed',
            error: message,
            completedAt: this.db.fn.now(),
            updatedAt: this.db.fn.now(),
          })
          .returning('*');
        await this.pauseScheduleForError(schedule, message);
        return this.serializeRun(failedRun);
      }
      const [failedRun] = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
        .insert({
          id: scheduleRunId,
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          status: 'failed',
          triggeredBy,
          error: message,
          startedAt: startedAt.toISOString(),
          completedAt: this.db.fn.now(),
        })
        .returning('*');
      await this.pauseScheduleForError(schedule, message);
      return this.serializeRun(failedRun);
    }
  }

  private async resolveOutputConversation(
    schedule: WorkspaceScheduleRow,
    userId: string,
    triggeredBy: 'scheduler' | 'manual',
  ): Promise<ConversationRecord> {
    if (schedule.outputMode === 'append_to_conversation' && schedule.targetConversationId) {
      return this.conversationService.ensureConversationAccess(
        userId,
        schedule.workspaceId,
        schedule.targetConversationId,
        { requireEdit: true },
      );
    }

    const conversation = await this.conversationService.createConversation(
      userId,
      schedule.workspaceId,
      schedule.persona || DEFAULT_PERSONA,
    );
    const titleSuffix = triggeredBy === 'manual' && schedule.outputMode === 'new_conversation_per_run'
      ? ` ${new Date().toLocaleString('en-US', { timeZone: schedule.timezone || DEFAULT_TIMEZONE })}`
      : '';
    await this.db('conversations')
      .where({ id: conversation.id })
      .update({
        title: titleFromScheduleName(`${schedule.name}${titleSuffix}`),
        updatedAt: this.db.fn.now(),
        updatedBy: userId,
      });
    return {
      ...conversation,
      title: titleFromScheduleName(`${schedule.name}${titleSuffix}`),
    };
  }

  private async refreshInFlightRuns(): Promise<void> {
    const rows = await this.db<WorkspaceScheduleRunRow>('workspace_schedule_runs')
      .whereIn('status', ['queued', 'running'])
      .whereNotNull('agentRunId')
      .orderBy('updatedAt', 'asc')
      .limit(MAX_IN_FLIGHT_RUNS_PER_TICK);

    for (const row of rows) {
      const agentRunId = row.agentRunId;
      if (!agentRunId) {
        continue;
      }
      const meta = await getRunMeta(agentRunId).catch(() => null);
      if (!meta) {
        continue;
      }
      await this.syncScheduleRunStatus(row, meta.status, meta.error);
    }
  }

  private async syncScheduleRunStatus(
    run: WorkspaceScheduleRunRow,
    status: AgentRunStatus,
    error?: string,
  ): Promise<void> {
    if (status === 'queued' || status === 'running') {
      await this.db('workspace_schedule_runs')
        .where({ id: run.id })
        .update({ status, updatedAt: this.db.fn.now() });
      return;
    }

    const completedAt = new Date();
    const scheduleStatus: WorkspaceScheduleStatus =
      status === 'completed' ? 'active' : status === 'awaiting_approval' ? 'paused' : 'error';
    const scheduleError =
      status === 'awaiting_approval'
        ? 'Scheduled run is waiting for human input and has been paused.'
        : status === 'completed'
          ? null
          : error || `Scheduled run ended with status "${status}".`;

    await this.db('workspace_schedule_runs')
      .where({ id: run.id })
      .update({
        status,
        error: scheduleError,
        completedAt,
        updatedAt: this.db.fn.now(),
      });
    await this.db('workspace_schedules')
      .where({ id: run.scheduleId })
      .update({
        status: scheduleStatus,
        lastRunStatus: status,
        lastError: scheduleError,
        lockedAt: null,
        lockedBy: null,
        updatedAt: this.db.fn.now(),
      });
  }

  private async pauseScheduleForError(schedule: WorkspaceScheduleRow, error: string): Promise<void> {
    await this.db('workspace_schedules')
      .where({ id: schedule.id })
      .update({
        status: 'error',
        lastRunStatus: 'failed',
        lastError: error,
        lockedAt: null,
        lockedBy: null,
        updatedAt: this.db.fn.now(),
      });
  }

  private serializeSchedule(row: WorkspaceScheduleRow): WorkspaceSchedule {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      status: row.status as WorkspaceScheduleStatus,
      cadence: row.cadence as WorkspaceScheduleCadence,
      cronExpression: row.cronExpression,
      timezone: row.timezone,
      prompt: row.prompt,
      persona: row.persona,
      selectedSkills: toJsonArray<string>(row.selectedSkills),
      contextRefs: toJsonArray<string>(row.contextRefs),
      taggedFiles: toJsonArray<string>(row.taggedFiles),
      fileContextRefs: toJsonArray<FileContextRef>(row.fileContextRefs),
      outputMode: row.outputMode as WorkspaceScheduleOutputMode,
      notificationMode: row.notificationMode as WorkspaceScheduleNotificationMode,
      sourceConversationId: row.sourceConversationId || null,
      sourceMessageId: row.sourceMessageId || null,
      targetConversationId: row.targetConversationId || null,
      nextRunAt: toIsoOrNull(row.nextRunAt),
      lastRunAt: toIsoOrNull(row.lastRunAt),
      lastRunStatus: (row.lastRunStatus as WorkspaceScheduleRunStatus | null) || null,
      lastError: row.lastError || null,
      createdBy: row.createdBy || null,
      runAsUserId: row.runAsUserId || null,
      createdAt: toIsoOrNull(row.createdAt) || new Date().toISOString(),
      updatedAt: toIsoOrNull(row.updatedAt) || new Date().toISOString(),
    };
  }

  private serializeRun(row: WorkspaceScheduleRunRow): WorkspaceScheduleRun {
    return {
      id: row.id,
      scheduleId: row.scheduleId,
      workspaceId: row.workspaceId,
      conversationId: row.conversationId || null,
      agentRunId: row.agentRunId || null,
      status: row.status as WorkspaceScheduleRunStatus,
      triggeredBy: row.triggeredBy === 'manual' ? 'manual' : 'scheduler',
      error: row.error || null,
      startedAt: toIsoOrNull(row.startedAt),
      completedAt: toIsoOrNull(row.completedAt),
      createdAt: toIsoOrNull(row.createdAt) || new Date().toISOString(),
      updatedAt: toIsoOrNull(row.updatedAt) || new Date().toISOString(),
    };
  }
}
