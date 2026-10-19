import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { ConflictError, NotFoundError } from '../errors';
import { DatabaseService } from './databaseService';
import { publishKnowledgeIngestionEvent } from './redisService';

export type KnowledgeJobStatus =
  | 'queued' | 'extracting' | 'structuring' | 'chunking' | 'enriching'
  | 'reducing' | 'validating' | 'indexing' | 'publishing' | 'published'
  | 'partial' | 'failed' | 'cancelled' | 'superseded';

const TERMINAL_STATUSES = new Set<KnowledgeJobStatus>([
  'published', 'partial', 'failed', 'cancelled', 'superseded',
]);

const JOB_PROGRESS: Record<string, { percent: number; label: string }> = {
  queued: { percent: 0, label: 'Queued' },
  processing: { percent: 10, label: 'Starting build' },
  extracting: { percent: 15, label: 'Reading source' },
  structuring: { percent: 30, label: 'Understanding structure' },
  chunking: { percent: 45, label: 'Preparing sections' },
  enriching: { percent: 65, label: 'Building knowledge' },
  reducing: { percent: 76, label: 'Consolidating concepts' },
  validating: { percent: 86, label: 'Validating bundle' },
  indexing: { percent: 93, label: 'Indexing knowledge' },
  publishing: { percent: 97, label: 'Publishing version' },
  published: { percent: 100, label: 'Published' },
  partial: { percent: 100, label: 'Published with warnings' },
  failed: { percent: 100, label: 'Failed' },
  cancelled: { percent: 0, label: 'Cancelled' },
  superseded: { percent: 0, label: 'Superseded' },
};

export class KnowledgeIngestionService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async queue(input: {
    knowledgeId: number;
    workspaceId: string;
    sourceFileId?: number | null;
    configuration?: Record<string, unknown>;
  }, transaction?: Knex.Transaction): Promise<any> {
    const runId = randomUUID();
    const persist = async (trx: Knex.Transaction) => {
      const superseded = await trx('knowledge_ingestion_jobs')
        .where({ knowledgeId: input.knowledgeId })
        .whereNotIn('status', Array.from(TERMINAL_STATUSES))
        .update({ status: 'superseded', stage: 'superseded', finishedAt: trx.fn.now(), updatedAt: trx.fn.now() })
        .returning('id');
      const supersededRunIds = superseded.map((row: any) => String(row.id));
      if (supersededRunIds.length) {
        await trx('knowledge_ingestion_tasks')
          .whereIn('runId', supersededRunIds)
          .whereIn('status', ['queued', 'processing'])
          .update({ status: 'cancelled', leaseOwner: null, leaseExpiresAt: null, updatedAt: trx.fn.now() });
      }
      await trx('knowledge_ingestion_jobs').insert({
        id: runId,
        knowledgeId: input.knowledgeId,
        workspaceId: input.workspaceId,
        sourceFileId: input.sourceFileId ?? null,
        status: 'queued',
        stage: 'queued',
        extractorVersion: 'helpudoc-extractor/2',
        enrichmentVersion: input.configuration?.enrichmentMode === 'gemini-lite'
          ? 'helpudoc-enrichment/gemini-lite-1'
          : 'helpudoc-enrichment/deterministic-1',
        okfGeneratorVersion: 'helpudoc-okf/2',
        modelProfile: input.configuration?.enrichmentMode === 'gemini-lite' ? 'lite' : null,
        configuration: input.configuration || { enrichmentMode: 'deterministic' },
      });
      await trx('knowledge_ingestion_tasks').insert({
        id: randomUUID(),
        runId,
        taskType: 'orchestrate',
        status: 'queued',
        input: {},
      });
    };
    if (transaction) await persist(transaction);
    else await this.db.transaction(persist);
    const row = await (transaction || this.db)('knowledge_ingestion_jobs').where({ id: runId }).first();
    if (!row) throw new NotFoundError('Knowledge ingestion run not found after queueing');
    const job = this.mapJob(row);
    if (!transaction) await this.publishQueued(input, job);
    return job;
  }

  async publishQueued(input: {
    workspaceId: string;
    knowledgeId: number;
  }, job: any): Promise<void> {
    await publishKnowledgeIngestionEvent({
      type: 'knowledge.ingestion.updated',
      workspaceId: input.workspaceId,
      knowledgeId: input.knowledgeId,
      job: this.mapNotificationJob(job),
    });
  }

  async get(runId: string): Promise<any> {
    const row = await this.db('knowledge_ingestion_jobs').where({ id: runId }).first();
    if (!row) throw new NotFoundError('Knowledge ingestion run not found');
    return this.mapJob(row);
  }

  async current(knowledgeId: number): Promise<any | null> {
    const row = await this.db('knowledge_ingestion_jobs')
      .where({ knowledgeId })
      .orderBy('createdAt', 'desc')
      .first();
    return row ? this.mapJob(row) : null;
  }

  async report(knowledgeId: number, runId: string): Promise<any> {
    const job = await this.db('knowledge_ingestion_jobs').where({ id: runId, knowledgeId }).first();
    if (!job) throw new NotFoundError('Knowledge ingestion run not found');
    const [tasks, usage, runSnapshot] = await Promise.all([
      this.db('knowledge_ingestion_tasks').where({ runId }).orderBy('createdAt', 'asc'),
      this.db('knowledge_usage_events').where({ runId }).orderBy('createdAt', 'asc'),
      this.db('knowledge_snapshots').where({ runId }).first(),
    ]);
    const snapshot = runSnapshot || (job.snapshotHash
      ? await this.db('knowledge_snapshots').where({ knowledgeId, contentHash: job.snapshotHash }).first()
      : null);
    const totals = usage.reduce((result: any, event: any) => ({
      inputTokens: result.inputTokens + Number(event.inputTokens || 0),
      cachedInputTokens: result.cachedInputTokens + Number(event.cachedInputTokens || 0),
      outputTokens: result.outputTokens + Number(event.outputTokens || 0),
      estimatedCost: result.estimatedCost + Number(event.estimatedCost || 0),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    return { job: this.mapJob(job), tasks, usage: { events: usage, totals }, snapshot: snapshot || null };
  }

  async transition(runId: string, patch: Record<string, unknown>): Promise<void> {
    const status = patch.status as KnowledgeJobStatus | undefined;
    const updates: Record<string, unknown> = { ...patch, updatedAt: this.db.fn.now() };
    // `warnings` is the jsonb column on knowledge_ingestion_jobs; pg would coerce a
    // raw JS array into a Postgres array literal (invalid json), so serialize it.
    if (Array.isArray(updates.warnings)) updates.warnings = JSON.stringify(updates.warnings);
    if (status === 'extracting') updates.startedAt = this.db.fn.now();
    if (status && TERMINAL_STATUSES.has(status)) updates.finishedAt = this.db.fn.now();
    await this.db('knowledge_ingestion_jobs').where({ id: runId }).update(updates);
    const job = await this.get(runId).catch(() => null);
    if (job) {
      await publishKnowledgeIngestionEvent({
        type: 'knowledge.ingestion.updated',
        workspaceId: String(job.workspaceId),
        knowledgeId: Number(job.knowledgeId),
        job: this.mapNotificationJob(job),
      });
    }
  }

  async claimTask(
    runId: string,
    taskType: string,
    leaseOwner: string,
    leaseSeconds = 6 * 60 * 60,
  ): Promise<any | null> {
    return this.db.transaction(async (trx) => {
      const now = new Date();
      const task = await trx('knowledge_ingestion_tasks')
        .where({ runId, taskType })
        .whereRaw('"attempts" < "maxAttempts"')
        .andWhere((builder) => {
          builder.where('status', 'queued').orWhere((expired) => {
            expired.where('status', 'processing').andWhere('leaseExpiresAt', '<', now);
          });
        })
        .forUpdate()
        .skipLocked()
        .first();
      if (!task) return null;
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      const [claimed] = await trx('knowledge_ingestion_tasks').where({ id: task.id }).update({
        status: 'processing',
        attempts: Number(task.attempts || 0) + 1,
        leaseOwner,
        leaseExpiresAt,
        updatedAt: trx.fn.now(),
      }).returning('*');
      return claimed;
    });
  }

  async renewTaskLease(taskId: string, leaseOwner: string, leaseSeconds = 120): Promise<boolean> {
    const updated = await this.db('knowledge_ingestion_tasks')
      .where({ id: taskId, status: 'processing', leaseOwner })
      .update({
        leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
        updatedAt: this.db.fn.now(),
      });
    return Number(updated) > 0;
  }

  async cancel(knowledgeId: number, runId: string): Promise<any> {
    const job = await this.db('knowledge_ingestion_jobs').where({ id: runId, knowledgeId }).first();
    if (!job) throw new NotFoundError('Knowledge ingestion run not found');
    if (TERMINAL_STATUSES.has(job.status)) throw new ConflictError('Knowledge ingestion run is already complete');
    await this.db.transaction(async (trx) => {
      await trx('knowledge_ingestion_jobs').where({ id: runId }).update({
        status: 'cancelled', stage: 'cancelled', cancelledAt: trx.fn.now(), finishedAt: trx.fn.now(), updatedAt: trx.fn.now(),
      });
      await trx('knowledge_ingestion_tasks')
        .where({ runId })
        .whereIn('status', ['queued', 'processing'])
        .update({ status: 'cancelled', leaseOwner: null, leaseExpiresAt: null, updatedAt: trx.fn.now() });
    });
    return this.get(runId);
  }

  mapJob(row: any): any {
    const discovered = Number(row.discoveredSourceUnits || 0);
    const processed = Number(row.processedSourceUnits || 0);
    const status = String(row.status || 'queued');
    const progress = JOB_PROGRESS[status] || JOB_PROGRESS.queued;
    return {
      ...row,
      progressPercent: progress.percent,
      progressLabel: progress.label,
      discoveredSourceUnits: discovered,
      processedSourceUnits: processed,
      failedSourceUnits: Number(row.failedSourceUnits || 0),
      coveragePercent: discovered ? Math.round((processed / discovered) * 10000) / 100 : 0,
    };
  }

  private mapNotificationJob(job: any): Record<string, unknown> {
    const { configuration: _configuration, leaseOwner: _leaseOwner, ...safeJob } = job;
    return safeJob;
  }
}

const STAGE_NAMES: Record<string, string> = {
  extracting: 'reading',
  structuring: 'structure',
  chunking: 'sectioning',
  enriching: 'concept-building',
  reducing: 'consolidation',
  validating: 'validation',
  indexing: 'indexing',
  publishing: 'publishing',
};

/**
 * Plain-language reason for a failed call to the agent.
 *
 * Users read this on the knowledge base page. An axios timeout used to show there as
 * "timeout of 300000ms exceeded", which reads like a crash. The agent's own reason
 * lives in `response.data.detail`; `error.message` alone is only the HTTP status.
 */
export const describeAgentCallFailure = (error: unknown): string => {
  const failure = error as { code?: string; message?: string; config?: { timeout?: number }; response?: { data?: { detail?: unknown } } };
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const timedOutAfter = /timeout of (\d+)ms exceeded/.exec(message);
  if (failure?.code === 'ECONNABORTED' || timedOutAfter) {
    const timeoutMs = Number(failure?.config?.timeout) || Number(timedOutAfter?.[1]) || 0;
    const minutes = Math.round(timeoutMs / 60_000);
    return minutes > 0
      ? `the step took longer than ${minutes} minute${minutes === 1 ? '' : 's'} and was stopped`
      : 'the step took too long and was stopped';
  }
  const detail = failure?.response?.data?.detail;
  if (detail) return `${message}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  return message;
};

/** The message stored on a failed build, naming the step it failed in. */
export const describeIngestionFailure = (error: unknown, stage?: string | null): string => {
  const reason = describeAgentCallFailure(error);
  const step = stage ? STAGE_NAMES[stage] : undefined;
  return step ? `The ${step} step failed: ${reason}.` : `The build failed: ${reason}.`;
};

export type IngestionProgress = {
  /** Plain-language step, e.g. "Consolidating concepts", never the raw stage name. */
  label: string;
  percent: number;
  /** Builds ahead of this one in the shared worker queue; only while queued. */
  queuedAhead: number | null;
  /** When the current step began. A stage change is the job row's last update. */
  stageSince: string | null;
  /**
   * The worker stopped renewing its lease, so it restarted or died mid-build. Another
   * pass resumes the build once the lease lapses, so this is a pause, not a failure.
   */
  stalled: boolean;
  /** Sections finished while concepts are built, the longest step; else null. */
  sections: { done: number; total: number } | null;
};

/**
 * Progress for one build, from its job and orchestrate task rows.
 *
 * *activeRunIds* are every unfinished build in the worker queue, oldest first. The
 * worker is shared by all knowledge bases, so a file can wait behind another team's
 * upload, and "queued" alone gave no hint of how long.
 */
export const summarizeIngestionProgress = (input: {
  runId: string;
  status: string;
  activeRunIds: string[];
  jobUpdatedAt?: Date | string | null;
  taskStatus?: string | null;
  taskLeaseExpiresAt?: Date | string | null;
  sectionsDone?: unknown;
  sectionsTotal?: unknown;
  now?: Date;
}): IngestionProgress => {
  const progress = JOB_PROGRESS[input.status] || JOB_PROGRESS.queued;
  const now = input.now ?? new Date();
  const position = input.activeRunIds.indexOf(input.runId);
  const leaseExpiresAt = input.taskLeaseExpiresAt ? new Date(input.taskLeaseExpiresAt) : null;
  return {
    label: progress.label,
    percent: progress.percent,
    queuedAhead: input.status === 'queued' && position >= 0 ? position : null,
    stageSince: input.jobUpdatedAt ? new Date(input.jobUpdatedAt).toISOString() : null,
    stalled: input.taskStatus === 'processing'
      && leaseExpiresAt !== null
      && leaseExpiresAt.getTime() < now.getTime(),
    sections: input.status === 'enriching' && Number(input.sectionsTotal) > 0
      ? {
        done: Math.min(Number(input.sectionsTotal), Math.max(0, Number(input.sectionsDone) || 0)),
        total: Number(input.sectionsTotal),
      }
      : null,
  };
};

/**
 * Warnings that mean a built document holds less than it should.
 *
 * A build that published from its map results after reduce failed, or lost pages,
 * showed the same green tick as a complete one. Extraction also records page-level
 * notes (OCR and similar) that are routine, so only these are surfaced.
 */
const KNOWLEDGE_LOSS_WARNING_CODES = new Set(['reduce_failed', 'vector_index_failed']);

export const buildQualityWarnings = (ingestion: Record<string, any> | null | undefined): string[] => {
  if (!ingestion) return [];
  const messages: string[] = [];
  const failed = Number(ingestion.failedSourceUnits || 0);
  const discovered = Number(ingestion.discoveredSourceUnits || 0);
  if (ingestion.status === 'partial' && failed > 0) {
    messages.push(discovered > 0
      ? `${failed} of ${discovered} parts of the document could not be read and are missing.`
      : `${failed} parts of the document could not be read and are missing.`);
  }
  const warnings = Array.isArray(ingestion.warnings) ? ingestion.warnings : [];
  for (const warning of warnings) {
    if (warning && KNOWLEDGE_LOSS_WARNING_CODES.has(String(warning.code)) && warning.message) {
      messages.push(String(warning.message));
    }
  }
  return messages;
};

export const ACTIVE_INGESTION_STATUSES: KnowledgeJobStatus[] = [
  'queued', 'extracting', 'structuring', 'chunking', 'enriching',
  'reducing', 'validating', 'indexing', 'publishing',
];
