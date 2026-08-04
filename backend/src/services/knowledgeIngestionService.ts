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
  }): Promise<any> {
    const runId = randomUUID();
    await this.db.transaction(async (trx) => {
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
    });
    const job = await this.get(runId);
    await publishKnowledgeIngestionEvent({
      type: 'knowledge.ingestion.updated',
      workspaceId: input.workspaceId,
      knowledgeId: input.knowledgeId,
      job: this.mapNotificationJob(job),
    });
    return job;
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
