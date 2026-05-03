import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import {
  deleteInternalMemoryFile,
  getInternalMemoryFile,
  putInternalMemoryFile,
  runInternalAnalysis,
} from './agentService';
import { signAgentContextToken } from './agentToken';
import { buildUserMemoryPath } from './userMemoryPaths';
import type {
  SkillEvolutionEvidence,
  SkillEvolutionSuggestion,
  SkillEvolutionSuggestionStatus,
  SkillEvolutionTargetKind,
} from '../../../packages/shared/src/types';
import { ConflictError, NotFoundError } from '../errors';

const repoRoot = path.resolve(__dirname, '../../..');
const skillsRoot = process.env.SKILLS_ROOT ? path.resolve(process.env.SKILLS_ROOT) : path.join(repoRoot, 'skills');

const SKILL_ID_PATTERN = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;

const LEARNINGS_REL_PATH = path.join('docs', 'HELPUDOC_LEARNINGS.md');

const EVOLUTION_SYSTEM_PROMPT = [
  'You propose durable skill-routing and shared skill-learning updates for an internal agent platform.',
  'Return strict JSON only: an array of objects.',
  'Each object must be one of:',
  '- {"targetKind":"memory_skill_routing","memoryScope":"global"|"workspace","rationale":string,"proposedContent":string}',
  '- {"targetKind":"skill_learnings","skillId":string,"rationale":string,"proposedContent":string}',
  'Rules:',
  '- Propose at most one memory_skill_routing for global and at most one for workspace when workspace applies.',
  '- Propose at most one skill_learnings per skillId listed in the prompt.',
  '- proposedContent must be the full replacement markdown for that target.',
  '- Focus on routing friction, wrong skill selection, tool failures, interrupts, or repeated corrections shown in evidence.',
  '- If nothing actionable, return [].',
].join('\n');

type RunSummary = {
  runId: string;
  workspaceId: string;
  userId?: string | null;
  conversationId?: string | null;
  persona: string;
  status: string;
  skillId?: string | null;
  hadInterrupt: boolean;
  toolErrorCount: number;
  approvalInterruptCount: number;
  clarificationInterruptCount: number;
};

function hashContent(content: string): string {
  return createHash('sha256').update(content || '').digest('hex');
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function isValidSkillId(id: string): boolean {
  return SKILL_ID_PATTERN.test(id.trim().replace(/^\/+|\/+$/g, ''));
}

function resolveLearningsFile(skillId: string): string {
  const normalized = skillId.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!isValidSkillId(normalized)) {
    throw new Error('Invalid skill id');
  }
  const base = path.join(skillsRoot, normalized);
  const resolved = path.resolve(base, LEARNINGS_REL_PATH);
  const skillRoot = path.resolve(base);
  if (!resolved.startsWith(skillRoot + path.sep) && resolved !== skillRoot) {
    throw new Error('Invalid path');
  }
  return resolved;
}

function rowToSuggestion(row: any): SkillEvolutionSuggestion {
  return {
    id: row.id,
    targetKind: row.targetKind as SkillEvolutionTargetKind,
    memoryUserId: row.memoryUserId,
    memoryTargetPath: row.memoryTargetPath ?? null,
    targetSkillId: row.targetSkillId ?? null,
    workspaceId: row.workspaceId ?? null,
    evidence: (row.evidence || {}) as SkillEvolutionEvidence,
    rationale: row.rationale,
    baseContentHash: row.baseContentHash,
    baseContentSnapshot: row.baseContentSnapshot ?? null,
    proposedContent: row.proposedContent,
    status: row.status as SkillEvolutionSuggestionStatus,
    reviewedContent: row.reviewedContent ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function shouldAnalyzeRun(row: RunSummary): boolean {
  if (!row.userId || !row.conversationId) {
    return false;
  }
  if (row.status !== 'completed' && row.status !== 'failed') {
    return false;
  }
  return Boolean(
    row.skillId
      || row.hadInterrupt
      || row.toolErrorCount > 0
      || row.status === 'failed'
      || row.approvalInterruptCount > 0
      || row.clarificationInterruptCount > 0,
  );
}

export class SkillEvolutionService {
  private readonly db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async listSuggestions(statusFilter?: string): Promise<SkillEvolutionSuggestion[]> {
    const query = this.db('skill_evolution_suggestions').orderBy('createdAt', 'desc');
    if (statusFilter && statusFilter !== 'all') {
      query.where({ status: statusFilter });
    }
    const rows = await query;
    return rows.map((row: any) => rowToSuggestion(row));
  }

  async decideSuggestion(
    adminUserId: string,
    suggestionId: string,
    decision: 'accept' | 'reject',
    editedContent?: string,
  ): Promise<SkillEvolutionSuggestion> {
    const row = await this.db('skill_evolution_suggestions').where({ id: suggestionId }).first();
    if (!row) {
      throw new NotFoundError('Skill evolution suggestion not found');
    }
    if (row.status !== 'pending') {
      const snapshot = rowToSuggestion(row);
      const message =
        row.status === 'stale'
          ? 'This suggestion was superseded by a newer proposal'
          : 'This suggestion is no longer pending';
      throw new ConflictError(message, { suggestion: snapshot });
    }
    const suggestion = rowToSuggestion(row);
    const reviewedAt = new Date().toISOString();

    if (decision === 'reject') {
      const [updated] = await this.db('skill_evolution_suggestions')
        .where({ id: suggestionId })
        .update({
          status: 'rejected',
          reviewedAt,
          reviewedByUserId: adminUserId,
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      return rowToSuggestion(updated);
    }

    const contentToWrite = editedContent !== undefined ? editedContent : suggestion.proposedContent;

    if (suggestion.targetKind === 'memory_skill_routing') {
      const targetPath = suggestion.memoryTargetPath;
      if (!targetPath) {
        throw new NotFoundError('Missing memory target path');
      }
      const token = signAgentContextToken({
        sub: suggestion.memoryUserId,
        userId: suggestion.memoryUserId,
        workspaceId: suggestion.workspaceId || undefined,
      }) || undefined;
      const currentFile = await getInternalMemoryFile(targetPath, { authToken: token });
      const currentHash = hashContent(currentFile.content || '');
      if (currentHash !== suggestion.baseContentHash) {
        const [updated] = await this.db('skill_evolution_suggestions')
          .where({ id: suggestionId })
          .update({
            status: 'stale',
            reviewedAt,
            reviewedByUserId: adminUserId,
            updatedAt: this.db.fn.now(),
          })
          .returning('*');
        throw new ConflictError('Target file changed since this suggestion was created', {
          suggestion: rowToSuggestion(updated),
        });
      }
      if (contentToWrite.trim()) {
        await putInternalMemoryFile({ path: targetPath, content: contentToWrite }, { authToken: token });
      } else {
        await deleteInternalMemoryFile(targetPath, { authToken: token });
      }
    } else if (suggestion.targetKind === 'skill_learnings') {
      const skillId = suggestion.targetSkillId;
      if (!skillId) {
        throw new NotFoundError('Missing target skill');
      }
      const absPath = resolveLearningsFile(skillId);
      let current = '';
      try {
        current = await fs.readFile(absPath, 'utf-8');
      } catch {
        current = '';
      }
      const currentHash = hashContent(current);
      if (currentHash !== suggestion.baseContentHash) {
        const [updated] = await this.db('skill_evolution_suggestions')
          .where({ id: suggestionId })
          .update({
            status: 'stale',
            reviewedAt,
            reviewedByUserId: adminUserId,
            updatedAt: this.db.fn.now(),
          })
          .returning('*');
        throw new ConflictError('Target file changed since this suggestion was created', {
          suggestion: rowToSuggestion(updated),
        });
      }
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, contentToWrite, 'utf-8');
    } else {
      throw new NotFoundError('Unknown target kind');
    }

    const [updated] = await this.db('skill_evolution_suggestions')
      .where({ id: suggestionId })
      .update({
        status: 'accepted',
        reviewedContent: contentToWrite,
        reviewedAt,
        reviewedByUserId: adminUserId,
        updatedAt: this.db.fn.now(),
      })
      .returning('*');

    return rowToSuggestion(updated);
  }

  async generateManual(limit = 40): Promise<{ processed: number; inserted: number }> {
    const rows = await this.db('agent_run_summaries')
      .whereIn('status', ['completed', 'failed'])
      .whereNotNull('conversationId')
      .whereNotNull('userId')
      .orderBy('completedAt', 'desc')
      .limit(limit);

    const mapped: RunSummary[] = rows.map((r: any) => ({
      runId: r.runId,
      workspaceId: r.workspaceId,
      userId: r.userId,
      conversationId: r.conversationId,
      persona: r.persona,
      status: r.status,
      skillId: r.skillId,
      hadInterrupt: Boolean(r.hadInterrupt),
      toolErrorCount: Number(r.toolErrorCount || 0),
      approvalInterruptCount: Number(r.approvalInterruptCount || 0),
      clarificationInterruptCount: Number(r.clarificationInterruptCount || 0),
    }));

    let inserted = 0;
    for (const row of mapped) {
      const n = await this.proposeFromRun(row);
      inserted += n;
    }
    return { processed: mapped.length, inserted };
  }

  async generateForRuns(runs: RunSummary[]): Promise<void> {
    let processed = 0;
    const maxRuns = 25;
    for (const row of runs) {
      if (processed >= maxRuns) {
        break;
      }
      if (!shouldAnalyzeRun(row)) {
        continue;
      }
      await this.proposeFromRun(row);
      processed += 1;
    }
  }

  async proposeFromRun(row: RunSummary): Promise<number> {
    if (!shouldAnalyzeRun(row)) {
      return 0;
    }
    const userId = String(row.userId || '').trim();
    const conversationId = String(row.conversationId || '').trim();
    if (!userId || !conversationId) {
      return 0;
    }

    const messages = await this.db('conversation_messages')
      .where({ conversationId })
      .orderBy('createdAt', 'asc');
    if (!messages.length) {
      return 0;
    }

    const transcript = messages
      .slice(-14)
      .map((message: any) => `${message.sender === 'agent' ? 'Agent' : 'User'}: ${String(message.text || '').trim()}`)
      .filter(Boolean)
      .join('\n');

    const toolRows = await this.db('agent_run_tool_events')
      .where({ runId: row.runId })
      .orderBy('eventIndex', 'asc')
      .select('toolName', 'eventType', 'summary');

    const toolLines = toolRows
      .map((t: any) => `${t.toolName || 'tool'}:${t.eventType || ''}${t.summary ? ` ${String(t.summary).slice(0, 120)}` : ''}`)
      .slice(0, 40);

    const skillIds = new Set<string>();
    if (row.skillId && isValidSkillId(row.skillId)) {
      skillIds.add(row.skillId.trim());
    }
    for (const t of toolRows) {
      if (t.toolName === 'load_skill' && typeof t.summary === 'string') {
        const m = t.summary.match(/skill[_-]?id["']?\s*[:=]\s*["']([^"']+)["']/i) || t.summary.match(/Loaded skill:\s*(\S+)/i);
        if (m?.[1] && isValidSkillId(m[1])) {
          skillIds.add(m[1].trim());
        }
      }
    }
    if (!skillIds.size) {
      skillIds.add('general');
    }

    const globalRoutingPath = buildUserMemoryPath('global', 'skill-routing');
    const workspaceRoutingPath = buildUserMemoryPath('workspace', 'skill-routing', row.workspaceId);

    const userToken = signAgentContextToken({
      sub: userId,
      userId,
      workspaceId: row.workspaceId,
    }) || undefined;

    const [globalRouteFile, workspaceRouteFile] = await Promise.all([
      getInternalMemoryFile(globalRoutingPath, { authToken: userToken }),
      getInternalMemoryFile(workspaceRoutingPath, { authToken: userToken }),
    ]);

    const learningsSnapshots: string[] = [];
    for (const sid of [...skillIds].sort()) {
      let text = '';
      try {
        text = await fs.readFile(resolveLearningsFile(sid), 'utf-8');
      } catch {
        text = '';
      }
      learningsSnapshots.push(`Skill ${sid} HELPUDOC_LEARNINGS.md:\n${text || '(missing / empty)'}`);
    }

    const authToken =
      signAgentContextToken({
        sub: userId,
        userId,
        workspaceId: row.workspaceId,
      }) || undefined;

    const analysis = await runInternalAnalysis(
      {
        systemPrompt: EVOLUTION_SYSTEM_PROMPT,
        userPrompt: [
          `Run ID: ${row.runId}`,
          `Conversation ID: ${conversationId}`,
          `Workspace ID: ${row.workspaceId}`,
          `User ID: ${userId}`,
          `Persona: ${row.persona}`,
          `Status: ${row.status}`,
          `Detected skillId: ${row.skillId || '(none)'}`,
          `Interrupts: had=${row.hadInterrupt} approvals=${row.approvalInterruptCount} clarifications=${row.clarificationInterruptCount}`,
          `Tool errors (count): ${row.toolErrorCount}`,
          '',
          'Tool timeline (sample):',
          ...toolLines.map((line) => `- ${line}`),
          '',
          'Candidate memory paths:',
          `- ${globalRoutingPath}`,
          `- ${workspaceRoutingPath}`,
          '',
          'Current memory skill-routing files:',
          `- ${globalRoutingPath}:\n${globalRouteFile.content || '(empty)'}`,
          `- ${workspaceRoutingPath}:\n${workspaceRouteFile.content || '(empty)'}`,
          '',
          ...learningsSnapshots,
          '',
          'Transcript excerpt:',
          transcript || '(empty)',
          '',
          `Candidate skill ids for skill_learnings proposals: ${[...skillIds].join(', ')}`,
        ].join('\n'),
      },
      { authToken },
    );

    const rawItems = extractJsonArray(analysis.text);
    let inserted = 0;

    for (const item of rawItems) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const targetKind = String(rec.targetKind || '').trim();
      const rationale = String(rec.rationale || '').trim();
      const proposedContent = String(rec.proposedContent || '').trim();
      if (!rationale || !proposedContent) {
        continue;
      }

      if (targetKind === 'memory_skill_routing') {
        const scope = String(rec.memoryScope || '').trim();
        if (scope !== 'global' && scope !== 'workspace') {
          continue;
        }
        const targetPath =
          scope === 'global'
            ? globalRoutingPath
            : workspaceRoutingPath;
        const currentFile = await getInternalMemoryFile(targetPath, { authToken: userToken });
        if ((currentFile.content || '').trim() === proposedContent.trim()) {
          continue;
        }
        // New proposals for the same target mark older pending rows stale so only one pending
        // review exists per target. Nightly or per-run generation can supersede an unreviewed prior
        // suggestion; that is intentional to keep proposals aligned with current file state.
        await this.db('skill_evolution_suggestions')
          .where({
            memoryUserId: userId,
            targetKind: 'memory_skill_routing',
            memoryTargetPath: targetPath,
            status: 'pending',
          })
          .update({
            status: 'stale',
            reviewedAt: new Date().toISOString(),
            updatedAt: this.db.fn.now(),
          });

        const evidence: SkillEvolutionEvidence = {
          sourceRunIds: [row.runId],
          sourceConversationIds: [conversationId],
          workspaceId: row.workspaceId,
          userId,
          persona: row.persona,
          skillId: row.skillId || null,
          transcriptExcerpt: transcript.slice(0, 4000),
          telemetrySummary: toolLines.slice(0, 20).join('\n'),
        };

        await this.db('skill_evolution_suggestions').insert({
          id: uuidv4(),
          targetKind: 'memory_skill_routing',
          memoryUserId: userId,
          memoryTargetPath: targetPath,
          targetSkillId: null,
          workspaceId: scope === 'workspace' ? row.workspaceId : null,
          evidence,
          rationale,
          baseContentHash: hashContent(currentFile.content || ''),
          baseContentSnapshot: currentFile.content || '',
          proposedContent,
          status: 'pending',
          createdAt: this.db.fn.now(),
          updatedAt: this.db.fn.now(),
        });
        inserted += 1;
      } else if (targetKind === 'skill_learnings') {
        const skillId = String(rec.skillId || '').trim();
        if (!isValidSkillId(skillId)) {
          continue;
        }
        const absPath = resolveLearningsFile(skillId);
        let current = '';
        try {
          current = await fs.readFile(absPath, 'utf-8');
        } catch {
          current = '';
        }
        if (current.trim() === proposedContent.trim()) {
          continue;
        }
        // Same staleness semantics as memory_skill_routing: one pending row per shared skill doc;
        // nightly or per-run generation can supersede an unreviewed prior suggestion.
        await this.db('skill_evolution_suggestions')
          .where({
            targetKind: 'skill_learnings',
            targetSkillId: skillId,
            status: 'pending',
          })
          .update({
            status: 'stale',
            reviewedAt: new Date().toISOString(),
            updatedAt: this.db.fn.now(),
          });

        const evidence: SkillEvolutionEvidence = {
          sourceRunIds: [row.runId],
          sourceConversationIds: [conversationId],
          workspaceId: row.workspaceId,
          userId,
          persona: row.persona,
          skillId: row.skillId || null,
          transcriptExcerpt: transcript.slice(0, 4000),
          telemetrySummary: toolLines.slice(0, 20).join('\n'),
        };

        await this.db('skill_evolution_suggestions').insert({
          id: uuidv4(),
          targetKind: 'skill_learnings',
          memoryUserId: userId,
          memoryTargetPath: null,
          targetSkillId: skillId,
          workspaceId: row.workspaceId,
          evidence,
          rationale,
          baseContentHash: hashContent(current),
          baseContentSnapshot: current,
          proposedContent,
          status: 'pending',
          createdAt: this.db.fn.now(),
          updatedAt: this.db.fn.now(),
        });
        inserted += 1;
      }
    }

    return inserted;
  }
}
