import { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import { runInternalAnalysis } from './agentService';
import { signAgentContextToken } from './agentToken';
import type {
  DailyReflection,
  ReflectionBreakdown,
  ReflectionConversationSample,
  ReflectionRecommendation,
  ReflectionScorecard,
  ReflectionTrendPoint,
} from '../../../packages/shared/src/types';
import { NotFoundError } from '../errors';

type RunRow = {
  runId: string;
  workspaceId: string;
  workspaceName?: string | null;
  userId?: string | null;
  userDisplayName?: string | null;
  conversationId?: string | null;
  conversationTitle?: string | null;
  turnId?: string | null;
  persona: string;
  status: string;
  skillId?: string | null;
  hadInterrupt: boolean;
  approvalInterruptCount: number;
  clarificationInterruptCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  error?: string | null;
  queuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

type ToolRow = {
  runId: string;
  toolName: string;
  eventType: string;
};

const REFLECTION_ANALYSIS_SYSTEM_PROMPT = [
  'You are writing a concise admin reflection for agent operations.',
  'Return strict JSON with keys summaryMarkdown and recommendations.',
  'summaryMarkdown should be short markdown with a top-level heading omitted.',
  'recommendations must be an array of up to 4 items with id, title, detail, priority.',
  'Focus on operational diagnosis and concrete improvement suggestions.',
].join('\n');

function resolveAnalyticsTimezone(): string {
  const timezone = String(process.env.ANALYTICS_TIMEZONE || 'UTC').trim();
  return timezone || 'UTC';
}

function formatDateInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function resolveReflectionDate(input?: string, timezone = resolveAnalyticsTimezone()): string {
  if (input && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return formatDateInTimezone(yesterday, timezone);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function round(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value);
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function durationMs(row: RunRow): number {
  if (!row.startedAt || !row.completedAt) {
    return 0;
  }
  const start = new Date(row.startedAt).getTime();
  const end = new Date(row.completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return end - start;
}

function buildScorecard(rows: RunRow[]): ReflectionScorecard {
  if (!rows.length) {
    return { outcome: 0, reliability: 0, friction: 0 };
  }

  const completed = rows.filter((row) => row.status === 'completed').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const cancelled = rows.filter((row) => row.status === 'cancelled').length;
  const interruptRate = rows.filter((row) => row.hadInterrupt).length / rows.length;
  const toolErrorRate = rows.filter((row) => row.toolErrorCount > 0).length / rows.length;
  const avgDurationMinutes = average(rows.map(durationMs)) / 60000;

  const outcome = Math.max(0, Math.min(100, round((completed / rows.length) * 100)));
  const reliability = Math.max(
    0,
    Math.min(100, round(100 - ((failed / rows.length) * 65 + (cancelled / rows.length) * 20 + toolErrorRate * 15))),
  );
  const friction = Math.max(
    0,
    Math.min(100, round(100 - interruptRate * 45 - Math.min(avgDurationMinutes, 15) * 2 - toolErrorRate * 20)),
  );

  return { outcome, reliability, friction };
}

function buildFallbackRecommendations(rows: RunRow[]): ReflectionRecommendation[] {
  const recommendations: ReflectionRecommendation[] = [];
  const failureCount = rows.filter((row) => row.status === 'failed').length;
  const interruptCount = rows.filter((row) => row.hadInterrupt).length;
  const toolErrorCount = rows.reduce((sum, row) => sum + row.toolErrorCount, 0);

  if (failureCount > 0) {
    recommendations.push({
      id: 'reduce-failures',
      title: 'Reduce failed runs',
      detail: `${failureCount} runs failed in this window. Review common failure paths and add targeted guardrails or retries.`,
      priority: 'high',
    });
  }
  if (interruptCount > Math.max(1, rows.length / 4)) {
    recommendations.push({
      id: 'lower-friction',
      title: 'Trim approval friction',
      detail: `Interrupts showed up in ${interruptCount} runs. Tighten skill prompts or defaults where repeated clarification is avoidable.`,
      priority: 'medium',
    });
  }
  if (toolErrorCount > 0) {
    recommendations.push({
      id: 'stabilize-tools',
      title: 'Stabilize tool execution',
      detail: `${toolErrorCount} tool errors were recorded. Focus on the highest-volume erroring tools first.`,
      priority: 'high',
    });
  }
  if (!recommendations.length) {
    recommendations.push({
      id: 'expand-sampling',
      title: 'Increase evaluation depth',
      detail: 'The day looks stable overall. Expand representative sampling to catch more subtle regressions and opportunities.',
      priority: 'low',
    });
  }
  return recommendations.slice(0, 4);
}

function buildFallbackSummary(
  date: string,
  timezone: string,
  rows: RunRow[],
  scorecard: ReflectionScorecard,
): string {
  const completed = rows.filter((row) => row.status === 'completed').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const interrupted = rows.filter((row) => row.hadInterrupt).length;
  return [
    `Reflection for ${date} (${timezone}).`,
    `${completed} of ${rows.length} runs completed successfully, ${failed} failed, and ${interrupted} needed interrupts.`,
    `Scorecard: Outcome ${scorecard.outcome}, Reliability ${scorecard.reliability}, Friction ${scorecard.friction}.`,
  ].join('\n\n');
}

function buildMetrics(rows: RunRow[]): Record<string, unknown> {
  const durations = rows.map(durationMs).filter((value) => value > 0);
  return {
    totalRuns: rows.length,
    completedRuns: rows.filter((row) => row.status === 'completed').length,
    failedRuns: rows.filter((row) => row.status === 'failed').length,
    cancelledRuns: rows.filter((row) => row.status === 'cancelled').length,
    interruptedRuns: rows.filter((row) => row.hadInterrupt).length,
    approvalInterrupts: rows.reduce((sum, row) => sum + row.approvalInterruptCount, 0),
    clarificationInterrupts: rows.reduce((sum, row) => sum + row.clarificationInterruptCount, 0),
    toolCallCount: rows.reduce((sum, row) => sum + row.toolCallCount, 0),
    toolErrorCount: rows.reduce((sum, row) => sum + row.toolErrorCount, 0),
    uniqueUsers: new Set(rows.map((row) => row.userId).filter(Boolean)).size,
    uniqueWorkspaces: new Set(rows.map((row) => row.workspaceId).filter(Boolean)).size,
    uniqueConversations: new Set(rows.map((row) => row.conversationId).filter(Boolean)).size,
    averageDurationMs: round(average(durations)),
  };
}

function metricNumber(metrics: Record<string, unknown>, key: string): number {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildRankedBreakdowns(
  reflectionId: number,
  dimension: ReflectionBreakdown['dimension'],
  entries: Array<{ entityKey: string; label: string; rows: RunRow[] }>,
): ReflectionBreakdown[] {
  return entries
    .map((entry) => {
      const metrics = buildMetrics(entry.rows);
      return {
        id: 0,
        reflectionId,
        dimension,
        entityKey: entry.entityKey,
        label: entry.label,
        rank: 0,
        metrics,
        summary: `${metricNumber(metrics, 'completedRuns')}/${metricNumber(metrics, 'totalRuns')} completed`,
      } satisfies ReflectionBreakdown;
    })
    .sort((left, right) => metricNumber(right.metrics, 'totalRuns') - metricNumber(left.metrics, 'totalRuns'))
    .map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
}

function buildSampleExcerpt(messages: Array<{ sender: string; text: string }>): string {
  const relevant = messages
    .filter((message) => String(message.text || '').trim())
    .slice(-2)
    .map((message) => `${message.sender === 'agent' ? 'Agent' : 'User'}: ${String(message.text || '').trim()}`);
  return relevant.join('\n').slice(0, 400);
}

export class DailyReflectionService {
  private readonly db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async getReflectionByDate(date: string, timezone = resolveAnalyticsTimezone()): Promise<DailyReflection> {
    const row = await this.db('agent_daily_reflections')
      .where({
        reflectionDate: date,
        timezone,
      })
      .first();
    if (!row) {
      throw new NotFoundError('Reflection not found');
    }
    return this.loadReflectionRow(row);
  }

  async getLatestReflection(timezone = resolveAnalyticsTimezone()): Promise<DailyReflection> {
    const row = await this.db('agent_daily_reflections')
      .where({ timezone })
      .orderBy('reflectionDate', 'desc')
      .first();
    if (!row) {
      throw new NotFoundError('Reflection not found');
    }
    return this.loadReflectionRow(row);
  }

  async getTrendPoints(days = 14, timezone = resolveAnalyticsTimezone()): Promise<ReflectionTrendPoint[]> {
    const limit = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 90) : 14;
    const rows = await this.db('agent_daily_reflections')
      .where({ timezone })
      .orderBy('reflectionDate', 'desc')
      .limit(limit);

    return rows
      .reverse()
      .map((row: any) => ({
        reflectionDate: row.reflectionDate,
        timezone: row.timezone,
        scorecard: {
          outcome: row.outcomeScore,
          reliability: row.reliabilityScore,
          friction: row.frictionScore,
        },
        metrics: row.metrics || {},
      }));
  }

  async generateReflection(dateInput?: string, timezone = resolveAnalyticsTimezone()): Promise<DailyReflection> {
    const reflectionDate = resolveReflectionDate(dateInput, timezone);
    const runs = await this.loadRunsForDate(reflectionDate, timezone);
    const toolEvents = runs.length ? await this.loadToolEvents(runs.map((row) => row.runId)) : [];
    const metrics = buildMetrics(runs);
    const scorecard = buildScorecard(runs);
    const sampledConversations = await this.buildSampledConversations(runs);
    const analysis = await this.generateNarrative(reflectionDate, timezone, metrics, scorecard, runs, toolEvents);
    const recommendations =
      analysis.recommendations.length > 0 ? analysis.recommendations : buildFallbackRecommendations(runs);

    const reflectionId = await this.db.transaction(async (trx) => {
      const existing = await trx('agent_daily_reflections')
        .where({
          reflectionDate,
          timezone,
        })
        .first();

      let persistedId: number;
      if (existing) {
        await trx('agent_daily_reflections')
          .where({ id: existing.id })
          .update({
            status: 'ready',
            outcomeScore: scorecard.outcome,
            reliabilityScore: scorecard.reliability,
            frictionScore: scorecard.friction,
            summaryMarkdown: analysis.summaryMarkdown,
            metrics,
            recommendations,
            sampledConversations,
            updatedAt: this.db.fn.now(),
          });
        persistedId = Number(existing.id);
        await trx('agent_daily_reflection_breakdowns').where({ reflectionId: persistedId }).del();
      } else {
        const [inserted] = await trx('agent_daily_reflections')
          .insert({
            reflectionDate,
            timezone,
            status: 'ready',
            outcomeScore: scorecard.outcome,
            reliabilityScore: scorecard.reliability,
            frictionScore: scorecard.friction,
            summaryMarkdown: analysis.summaryMarkdown,
            metrics,
            recommendations,
            sampledConversations,
            createdAt: this.db.fn.now(),
            updatedAt: this.db.fn.now(),
          })
          .returning('*');
        persistedId = Number(inserted.id);
      }

      const breakdowns = await this.buildBreakdowns(persistedId, runs, toolEvents);
      if (breakdowns.length) {
        await trx('agent_daily_reflection_breakdowns').insert(
          breakdowns.map((item) => ({
            reflectionId: persistedId,
            dimension: item.dimension,
            entityKey: item.entityKey,
            label: item.label,
            rank: item.rank,
            metrics: item.metrics,
            summary: item.summary || null,
            createdAt: this.db.fn.now(),
          })),
        );
      }
      return persistedId;
    });

    return this.getReflectionByDate(reflectionDate, timezone);
  }

  private async loadReflectionRow(row: any): Promise<DailyReflection> {
    const breakdownRows = await this.db('agent_daily_reflection_breakdowns')
      .where({ reflectionId: row.id })
      .orderBy([{ column: 'dimension', order: 'asc' }, { column: 'rank', order: 'asc' }]);

    return {
      id: Number(row.id),
      reflectionDate: row.reflectionDate,
      timezone: row.timezone,
      status: row.status,
      scorecard: {
        outcome: row.outcomeScore,
        reliability: row.reliabilityScore,
        friction: row.frictionScore,
      },
      summaryMarkdown: row.summaryMarkdown || '',
      metrics: row.metrics || {},
      recommendations: Array.isArray(row.recommendations) ? row.recommendations : [],
      sampledConversations: Array.isArray(row.sampledConversations) ? row.sampledConversations : [],
      breakdowns: breakdownRows.map((breakdown: any) => ({
        id: Number(breakdown.id),
        reflectionId: Number(breakdown.reflectionId),
        dimension: breakdown.dimension,
        entityKey: breakdown.entityKey,
        label: breakdown.label,
        rank: breakdown.rank,
        metrics: breakdown.metrics || {},
        summary: breakdown.summary || null,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async loadRunsForDate(date: string, timezone: string): Promise<RunRow[]> {
    const rows = await this.db('agent_run_summaries as runs')
      .leftJoin('users', 'runs.userId', 'users.id')
      .leftJoin('workspaces', 'runs.workspaceId', 'workspaces.id')
      .leftJoin('conversations', 'runs.conversationId', 'conversations.id')
      .select(
        'runs.runId',
        'runs.workspaceId',
        'runs.userId',
        'runs.conversationId',
        'runs.turnId',
        'runs.persona',
        'runs.status',
        'runs.skillId',
        'runs.hadInterrupt',
        'runs.approvalInterruptCount',
        'runs.clarificationInterruptCount',
        'runs.toolCallCount',
        'runs.toolErrorCount',
        'runs.error',
        'runs.queuedAt',
        'runs.startedAt',
        'runs.completedAt',
        'users.displayName as userDisplayName',
        'workspaces.name as workspaceName',
        'conversations.title as conversationTitle',
      )
      .whereRaw('DATE(timezone(?, COALESCE(runs."completedAt", runs."startedAt", runs."queuedAt"))) = ?', [timezone, date]);

    return rows.map((row: any) => ({
      runId: row.runId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName ?? null,
      userId: row.userId ?? null,
      userDisplayName: row.userDisplayName ?? null,
      conversationId: row.conversationId ?? null,
      conversationTitle: row.conversationTitle ?? null,
      turnId: row.turnId ?? null,
      persona: row.persona,
      status: row.status,
      skillId: row.skillId ?? null,
      hadInterrupt: Boolean(row.hadInterrupt),
      approvalInterruptCount: Number(row.approvalInterruptCount || 0),
      clarificationInterruptCount: Number(row.clarificationInterruptCount || 0),
      toolCallCount: Number(row.toolCallCount || 0),
      toolErrorCount: Number(row.toolErrorCount || 0),
      error: row.error ?? null,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null,
    }));
  }

  private async loadToolEvents(runIds: string[]): Promise<ToolRow[]> {
    if (!runIds.length) {
      return [];
    }
    const rows = await this.db('agent_run_tool_events')
      .select('runId', 'toolName', 'eventType')
      .whereIn('runId', runIds);

    return rows.map((row: any) => ({
      runId: row.runId,
      toolName: row.toolName,
      eventType: row.eventType,
    }));
  }

  private async buildSampledConversations(rows: RunRow[]): Promise<ReflectionConversationSample[]> {
    const candidates = [...rows]
      .sort((left, right) => {
        const severityLeft = (left.status === 'failed' ? 2 : 0) + left.toolErrorCount;
        const severityRight = (right.status === 'failed' ? 2 : 0) + right.toolErrorCount;
        return severityRight - severityLeft;
      })
      .slice(0, 6);

    const conversationIds = candidates.map((row) => row.conversationId).filter((value): value is string => Boolean(value));
    const messageRows = conversationIds.length
      ? await this.db('conversation_messages')
          .select('conversationId', 'sender', 'text', 'createdAt')
          .whereIn('conversationId', conversationIds)
          .orderBy('createdAt', 'asc')
      : [];

    const messagesByConversation = new Map<string, Array<{ sender: string; text: string }>>();
    for (const row of messageRows as any[]) {
      const list = messagesByConversation.get(row.conversationId) || [];
      list.push({ sender: row.sender, text: row.text });
      messagesByConversation.set(row.conversationId, list);
    }

    return candidates.map((row) => ({
      conversationId: row.conversationId || row.runId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName || null,
      userId: row.userId || null,
      userDisplayName: row.userDisplayName || null,
      title: row.conversationTitle || null,
      status: row.status as ReflectionConversationSample['status'],
      excerpt: row.conversationId ? buildSampleExcerpt(messagesByConversation.get(row.conversationId) || []) : null,
    }));
  }

  private async buildBreakdowns(
    reflectionId: number,
    runs: RunRow[],
    toolEvents: ToolRow[],
  ): Promise<ReflectionBreakdown[]> {
    const skillGroups = new Map<string, RunRow[]>();
    for (const run of runs) {
      const key = (run.skillId || run.persona || 'unknown').trim() || 'unknown';
      const list = skillGroups.get(key) || [];
      list.push(run);
      skillGroups.set(key, list);
    }

    const userGroups = new Map<string, RunRow[]>();
    for (const run of runs) {
      const key = run.userId || 'unknown';
      const list = userGroups.get(key) || [];
      list.push(run);
      userGroups.set(key, list);
    }

    const workspaceGroups = new Map<string, RunRow[]>();
    for (const run of runs) {
      const key = run.workspaceId || 'unknown';
      const list = workspaceGroups.get(key) || [];
      list.push(run);
      workspaceGroups.set(key, list);
    }

    const toolGroups = new Map<string, RunRow[]>();
    const runsById = new Map(runs.map((row) => [row.runId, row]));
    for (const event of toolEvents) {
      const run = runsById.get(event.runId);
      if (!run) {
        continue;
      }
      const key = event.toolName || 'unknown';
      const list = toolGroups.get(key) || [];
      list.push(run);
      toolGroups.set(key, list);
    }

    return [
      ...buildRankedBreakdowns(
        reflectionId,
        'skill',
        Array.from(skillGroups.entries()).map(([entityKey, group]) => ({
          entityKey,
          label: entityKey,
          rows: group,
        })),
      ),
      ...buildRankedBreakdowns(
        reflectionId,
        'user',
        Array.from(userGroups.entries()).map(([entityKey, group]) => ({
          entityKey,
          label: group[0]?.userDisplayName || entityKey,
          rows: group,
        })),
      ),
      ...buildRankedBreakdowns(
        reflectionId,
        'workspace',
        Array.from(workspaceGroups.entries()).map(([entityKey, group]) => ({
          entityKey,
          label: group[0]?.workspaceName || entityKey,
          rows: group,
        })),
      ),
      ...buildRankedBreakdowns(
        reflectionId,
        'tool',
        Array.from(toolGroups.entries()).map(([entityKey, group]) => ({
          entityKey,
          label: entityKey,
          rows: group,
        })),
      ),
    ];
  }

  private async generateNarrative(
    date: string,
    timezone: string,
    metrics: Record<string, unknown>,
    scorecard: ReflectionScorecard,
    runs: RunRow[],
    toolEvents: ToolRow[],
  ): Promise<{ summaryMarkdown: string; recommendations: ReflectionRecommendation[] }> {
    const authToken = signAgentContextToken({
      sub: 'system-admin',
      userId: 'system-admin',
      isAdmin: true,
    }) || undefined;

    try {
      const analysis = await runInternalAnalysis(
        {
          systemPrompt: REFLECTION_ANALYSIS_SYSTEM_PROMPT,
          userPrompt: JSON.stringify(
            {
              reflectionDate: date,
              timezone,
              scorecard,
              metrics,
              topRunOutcomes: runs.slice(0, 20).map((run) => ({
                workspaceName: run.workspaceName,
                userDisplayName: run.userDisplayName,
                conversationTitle: run.conversationTitle,
                status: run.status,
                skillId: run.skillId,
                toolCallCount: run.toolCallCount,
                toolErrorCount: run.toolErrorCount,
                hadInterrupt: run.hadInterrupt,
              })),
              toolSummary: Object.entries(
                toolEvents.reduce<Record<string, number>>((acc, event) => {
                  acc[event.toolName] = (acc[event.toolName] || 0) + 1;
                  return acc;
                }, {}),
              )
                .sort((left, right) => right[1] - left[1])
                .slice(0, 8)
                .map(([toolName, count]) => ({ toolName, count })),
            },
            null,
            2,
          ),
        },
        { authToken },
      );

      const parsed = parseJsonObject(analysis.text);
      if (!parsed) {
        throw new Error('Reflection analysis did not return JSON');
      }
      const summaryMarkdown =
        typeof parsed.summaryMarkdown === 'string' && parsed.summaryMarkdown.trim()
          ? parsed.summaryMarkdown.trim()
          : buildFallbackSummary(date, timezone, runs, scorecard);
      const recommendations = Array.isArray(parsed.recommendations)
        ? parsed.recommendations
            .filter((item): item is ReflectionRecommendation => Boolean(item && typeof item === 'object'))
            .map((item: any, index) => ({
              id: String(item.id || `recommendation-${index + 1}`),
              title: String(item.title || 'Recommendation').trim(),
              detail: String(item.detail || '').trim(),
              priority: item.priority === 'high' || item.priority === 'low' ? item.priority : 'medium',
            }))
            .filter((item) => item.title && item.detail)
        : [];

      return {
        summaryMarkdown,
        recommendations,
      };
    } catch (error) {
      console.warn('Falling back to heuristic daily reflection narrative', error);
      return {
        summaryMarkdown: buildFallbackSummary(date, timezone, runs, scorecard),
        recommendations: buildFallbackRecommendations(runs),
      };
    }
  }
}

export function getAnalyticsTimezone(): string {
  return resolveAnalyticsTimezone();
}
