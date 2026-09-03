import type { Knex } from 'knex';
import { promises as fs } from 'fs';
import { fetchLangfuseAggregates, isLangfuseConfigured, type LangfuseTracesListItem } from './langfuseClient';
import { collectSkillIds } from '../lib/skillsRegistry';
import type { UserService, UserRecord } from './userService';

export type AppActivityItem = {
  source: 'app';
  id: string;
  title: string;
  meta: string;
  at: string;
};

export type LangfuseActivityItem = {
  source: 'langfuse';
  id: string;
  title: string;
  meta: string;
  at: string;
};

export type WorkspaceOverviewActivity = AppActivityItem | LangfuseActivityItem;

export type WorkspaceOverviewResponse = {
  skills: { count: number };
  users: { total: number; messaged24h: number };
  langfuse: {
    available: boolean;
    configured: boolean;
    publicUrl: string | null;
    error?: string;
    traces7d: number;
    observations7d: number;
    recentTraces: LangfuseTracesListItem[];
  };
  activity: { items: WorkspaceOverviewActivity[] };
  focus: Array<{
    title: string;
    description: string;
    to: string;
    action: string;
  }>;
};

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;


export function buildFocusAreas(
  input: { skillCount: number; totalUsers: number; messaged24h: number; langfuseConfigured: boolean; langfuseAvailable: boolean; langfuseError?: string },
): Array<{ title: string; description: string; to: string; action: string }> {
  const { skillCount, totalUsers, messaged24h, langfuseConfigured, langfuseAvailable, langfuseError } = input;
  const out: Array<{ title: string; description: string; to: string; action: string }> = [];
  if (skillCount === 0) {
    out.push({
      title: 'Seed core skills',
      description: 'The registry is still empty. Add starter skills so the workspace feels ready on first use.',
      to: '/settings/agents',
      action: 'Open skill registry',
    });
  }
  if (totalUsers > 0 && messaged24h < Math.max(1, totalUsers) && totalUsers > 1) {
    out.push({
      title: 'Adoption and access',
      description: `Only ${messaged24h} user(s) had chat messages in the last 24 hours. Review users and access coverage as you scale the workspace.`,
      to: '/settings/users',
      action: 'Review users',
    });
  }
  if (langfuseConfigured && (!langfuseAvailable || langfuseError)) {
    out.push({
      title: 'Check Langfuse',
      description: 'Langfuse could not be reached for metrics, or the API returned an error. Verify the deployment and keys.',
      to: '/settings',
      action: 'Retry on refresh',
    });
  }
  if (out.length < 3) {
    out.push({
      title: 'Track knowledge readiness',
      description: 'Make ingestion health visible so indexed content is easy to trust and troubleshoot.',
      to: '/settings/knowledge',
      action: 'Review knowledge',
    });
  }
  return out.slice(0, 3);
}


export type BuildOverviewDeps = {
  db: Knex;
  userService: UserService;
  skillsRoot: string;
  nodeEnv?: string;
  fetchLangfuse: typeof fetchLangfuseAggregates;
  now: () => number;
};

export async function buildWorkspaceOverview(
  deps: BuildOverviewDeps,
): Promise<WorkspaceOverviewResponse> {
  const { db, userService, skillsRoot, nodeEnv, fetchLangfuse, now } = deps;
  const t0 = now();

  await fs.mkdir(skillsRoot, { recursive: true });
  const skillIds = await collectSkillIds(skillsRoot);

  const users: UserRecord[] = await userService.listUsers();
  const total = users.length;

  const from24 = new Date(t0 - MS_24H);
  const countRow = await db('conversation_messages')
    .whereNotNull('authorId')
    .andWhere('createdAt', '>=', from24)
    .countDistinct('authorId as c')
    .first() as { c?: string | number } | undefined;
  const rawC = countRow?.c;
  const messaged24h = typeof rawC === 'string' ? parseInt(rawC, 10) : Number(rawC) || 0;

  const from7 = new Date(t0 - MS_7D).toISOString();
  const to7 = new Date(t0).toISOString();
  const langfuseConfigured = isLangfuseConfigured();
  let langfuse: WorkspaceOverviewResponse['langfuse'] = {
    available: false,
    configured: langfuseConfigured,
    publicUrl: (process.env.LANGFUSE_NEXTAUTH_URL || '').trim() || null,
    traces7d: 0,
    observations7d: 0,
    recentTraces: [],
  };

  if (langfuseConfigured) {
    try {
      const agg = await fetchLangfuse(from7, to7);
      const err = (nodeEnv === 'development' && agg.error) ? agg.error : undefined;
      langfuse = {
        available: agg.available,
        configured: true,
        publicUrl: agg.publicUrl,
        error: err,
        traces7d: agg.traces7d,
        observations7d: agg.observations7d,
        recentTraces: agg.recentTraces,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      langfuse = {
        available: false,
        configured: true,
        publicUrl: (process.env.LANGFUSE_NEXTAUTH_URL || '').trim() || null,
        error: nodeEnv === 'development' ? message : undefined,
        traces7d: 0,
        observations7d: 0,
        recentTraces: [],
      };
    }
  }

  const lfItems: LangfuseActivityItem[] = (langfuse.recentTraces || []).map((tr) => ({
    source: 'langfuse' as const,
    id: `t:${tr.id}`,
    title: (tr.name && tr.name.trim()) || 'Trace',
    meta: 'Langfuse',
    at: (tr.timestamp && tr.timestamp.trim()) || new Date(t0).toISOString(),
  }));

  const focus = buildFocusAreas({
    skillCount: skillIds.length,
    totalUsers: total,
    messaged24h,
    langfuseConfigured: langfuse.configured,
    langfuseAvailable: langfuse.available,
    langfuseError: langfuse.error,
  });

  return {
    skills: { count: skillIds.length },
    users: { total, messaged24h },
    langfuse,
    // Always empty. The activity feed moved to `GET /api/activity`, which scopes
    // by role and reads the audit trail. The query that used to fill this read
    // the five most recent chat messages across every user, previews included,
    // with no filter on the author. The field stays so the response shape does
    // not change for older clients.
    activity: { items: [] },
    focus,
  };
}
