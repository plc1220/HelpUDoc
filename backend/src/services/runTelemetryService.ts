import { Knex } from 'knex';
import { DatabaseService } from './databaseService';

export type AgentRunTelemetryStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunQueuedInput = {
  runId: string;
  workspaceId: string | null;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  persona: string;
  queuedAt: string;
  status?: AgentRunTelemetryStatus;
};

export type AgentRunToolEventInput = {
  runId: string;
  workspaceId: string | null;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  eventIndex: number;
  toolName: string;
  eventType: 'start' | 'end' | 'error';
  summary?: string;
  outputFiles?: unknown;
  payload?: Record<string, unknown>;
  eventAt?: string;
};

export type AgentRunFinalizeInput = {
  status: AgentRunTelemetryStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  skillId?: string | null;
  hadInterrupt?: boolean;
  approvalInterruptCount?: number;
  clarificationInterruptCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  metadata?: Record<string, unknown>;
};

export type AgentRunProgress = {
  hadInterrupt: boolean;
  approvalInterruptCount: number;
  clarificationInterruptCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  maxEventIndex: number;
};

const normalizeJsonValue = (value: unknown, options: { parseStrings?: boolean } = {}): unknown => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    if (options.parseStrings) {
      try {
        return normalizeJsonValue(JSON.parse(trimmed), options);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item, options));
  }
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      if (typeof item !== 'undefined') {
        normalized[key] = normalizeJsonValue(item, {
          parseStrings: options.parseStrings || key === 'outputFiles',
        });
      }
    });
    return normalized;
  }
  return value;
};

const normalizeOutputFiles = (value: unknown): Array<Record<string, unknown>> | null => {
  const normalized = normalizeJsonValue(value, { parseStrings: true });
  if (!Array.isArray(normalized)) {
    return null;
  }
  const files = normalized
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const path = String((item as Record<string, unknown>).path || '').trim();
      if (!path) {
        return null;
      }
      return item as Record<string, unknown>;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  return files.length ? files : null;
};

const jsonbParam = (db: Knex, value: unknown) => (
  value === null || typeof value === 'undefined'
    ? null
    : db.raw('?::jsonb', [JSON.stringify(value)])
);

export const normalizeToolEventJson = (input: Pick<AgentRunToolEventInput, 'outputFiles' | 'payload'>) => ({
  outputFiles: normalizeOutputFiles(input.outputFiles),
  payload: normalizeJsonValue(input.payload),
});

export class RunTelemetryService {
  private readonly db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async recordQueuedRun(input: AgentRunQueuedInput): Promise<void> {
    await this.db('agent_run_summaries')
      .insert({
        runId: input.runId,
        workspaceId: input.workspaceId,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        turnId: input.turnId || null,
        persona: input.persona,
        status: input.status || 'queued',
        queuedAt: input.queuedAt,
        createdAt: this.db.fn.now(),
        updatedAt: this.db.fn.now(),
      })
      .onConflict('runId')
      .merge({
        workspaceId: input.workspaceId,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        turnId: input.turnId || null,
        persona: input.persona,
        status: input.status || 'queued',
        queuedAt: input.queuedAt,
        updatedAt: this.db.fn.now(),
      });
  }

  async markRunStarted(runId: string, startedAt: string): Promise<void> {
    await this.db('agent_run_summaries')
      .where({ runId })
      .update({
        status: 'running',
        startedAt: this.db.raw('COALESCE("startedAt", ?)', [startedAt]),
        updatedAt: this.db.fn.now(),
      });
  }

  async getRunProgress(runId: string): Promise<AgentRunProgress> {
    const [summary, eventRow] = await Promise.all([
      this.db('agent_run_summaries')
        .select(
          'hadInterrupt',
          'approvalInterruptCount',
          'clarificationInterruptCount',
          'toolCallCount',
          'toolErrorCount',
        )
        .where({ runId })
        .first(),
      this.db('agent_run_tool_events')
        .max<{ maxEventIndex?: string | number | null }>('eventIndex as maxEventIndex')
        .where({ runId })
        .first(),
    ]);

    return {
      hadInterrupt: Boolean(summary?.hadInterrupt),
      approvalInterruptCount: Number(summary?.approvalInterruptCount || 0),
      clarificationInterruptCount: Number(summary?.clarificationInterruptCount || 0),
      toolCallCount: Number(summary?.toolCallCount || 0),
      toolErrorCount: Number(summary?.toolErrorCount || 0),
      maxEventIndex: Number(eventRow?.maxEventIndex || 0),
    };
  }

  async appendToolEvent(input: AgentRunToolEventInput): Promise<void> {
    const normalizedJson = normalizeToolEventJson(input);
    await this.db('agent_run_tool_events')
      .insert({
        runId: input.runId,
        workspaceId: input.workspaceId,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        turnId: input.turnId || null,
        eventIndex: input.eventIndex,
        toolName: input.toolName,
        eventType: input.eventType,
        summary: input.summary || null,
        outputFiles: jsonbParam(this.db, normalizedJson.outputFiles),
        payload: jsonbParam(this.db, normalizedJson.payload),
        eventAt: input.eventAt || new Date().toISOString(),
        createdAt: this.db.fn.now(),
      })
      .onConflict(['runId', 'eventIndex'])
      .ignore();
  }

  async finalizeRun(runId: string, input: AgentRunFinalizeInput): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      status: input.status,
      error: input.error || null,
      updatedAt: this.db.fn.now(),
    };
    if (input.startedAt) {
      updatePayload.startedAt = input.startedAt;
    }
    if (input.completedAt) {
      updatePayload.completedAt = input.completedAt;
    }
    if (input.skillId !== undefined) {
      updatePayload.skillId = input.skillId || null;
    }
    if (typeof input.hadInterrupt === 'boolean') {
      updatePayload.hadInterrupt = input.hadInterrupt;
    }
    if (typeof input.approvalInterruptCount === 'number') {
      updatePayload.approvalInterruptCount = input.approvalInterruptCount;
    }
    if (typeof input.clarificationInterruptCount === 'number') {
      updatePayload.clarificationInterruptCount = input.clarificationInterruptCount;
    }
    if (typeof input.toolCallCount === 'number') {
      updatePayload.toolCallCount = input.toolCallCount;
    }
    if (typeof input.toolErrorCount === 'number') {
      updatePayload.toolErrorCount = input.toolErrorCount;
    }
    if (input.metadata) {
      updatePayload.metadata = input.metadata;
    }

    await this.db('agent_run_summaries')
      .where({ runId })
      .update(updatePayload);
  }
}
