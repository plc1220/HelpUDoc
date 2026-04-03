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
  workspaceId: string;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  persona: string;
  queuedAt: string;
  status?: AgentRunTelemetryStatus;
};

export type AgentRunToolEventInput = {
  runId: string;
  workspaceId: string;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  eventIndex: number;
  toolName: string;
  eventType: 'start' | 'end' | 'error';
  summary?: string;
  outputFiles?: Array<Record<string, unknown>>;
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
        startedAt,
        updatedAt: this.db.fn.now(),
      });
  }

  async appendToolEvent(input: AgentRunToolEventInput): Promise<void> {
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
        outputFiles: input.outputFiles || null,
        payload: input.payload || null,
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
