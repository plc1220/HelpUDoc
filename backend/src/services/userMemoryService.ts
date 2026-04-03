import { createHash } from 'crypto';
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
import {
  buildUserMemoryPath,
  describeUserMemoryPath,
  emptyUserMemoryView,
  type UserMemoryScope,
  type UserMemorySection,
} from './userMemoryPaths';
import type { UserMemorySuggestion, UserMemoryView } from '../../../packages/shared/src/types';
import { ConflictError, NotFoundError } from '../errors';

type UpdateMemoryInput = {
  userId: string;
  scope: UserMemoryScope;
  section: UserMemorySection;
  workspaceId?: string;
  content: string;
};

type SuggestForCompletedRunInput = {
  runId: string;
  userId?: string;
  workspaceId: string;
  conversationId?: string;
};

type MemorySuggestionCandidate = {
  targetPath: string;
  rationale: string;
  proposedContent: string;
};

type MemorySuggestionRow = {
  id: string;
  userId: string;
  workspaceId?: string | null;
  sourceConversationId?: string | null;
  sourceRunId?: string | null;
  targetPath: string;
  targetScope: UserMemoryScope;
  targetSection: UserMemorySection;
  baseContentHash: string;
  proposedContent: string;
  rationale: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  reviewedContent?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

const MEMORY_ANALYSIS_SYSTEM_PROMPT = [
  'You extract durable user memory suggestions for an agent product.',
  'Return strict JSON only: an array of objects with targetPath, rationale, proposedContent.',
  'Rules:',
  '- Suggest only stable user preferences or durable long-term project context.',
  '- Ignore one-off task instructions, temporary requests, and admin/tool permissions.',
  '- Propose at most one suggestion per targetPath.',
  '- Only use the provided candidate targetPath values.',
  '- proposedContent must be the full replacement file content for that targetPath.',
  '- If nothing is worth saving, return [].',
].join('\n');

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

function toSuggestionRow(row: any): MemorySuggestionRow {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    sourceConversationId: row.sourceConversationId ?? null,
    sourceRunId: row.sourceRunId ?? null,
    targetPath: row.targetPath,
    targetScope: row.targetScope,
    targetSection: row.targetSection,
    baseContentHash: row.baseContentHash,
    proposedContent: row.proposedContent,
    rationale: row.rationale,
    status: row.status,
    reviewedContent: row.reviewedContent ?? null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class UserMemoryService {
  private readonly db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async getMemoryView(userId: string, workspaceId?: string): Promise<UserMemoryView> {
    const token = this.buildMemoryToken(userId, workspaceId);
    const paths = {
      globalPreferences: buildUserMemoryPath('global', 'preferences'),
      globalContext: buildUserMemoryPath('global', 'context'),
      workspacePreferences: workspaceId ? buildUserMemoryPath('workspace', 'preferences', workspaceId) : null,
      workspaceContext: workspaceId ? buildUserMemoryPath('workspace', 'context', workspaceId) : null,
    };

    const [globalPreferences, globalContext, workspacePreferences, workspaceContext] = await Promise.all([
      getInternalMemoryFile(paths.globalPreferences, { authToken: token }),
      getInternalMemoryFile(paths.globalContext, { authToken: token }),
      paths.workspacePreferences
        ? getInternalMemoryFile(paths.workspacePreferences, { authToken: token })
        : Promise.resolve({ path: '', exists: false, content: '' }),
      paths.workspaceContext
        ? getInternalMemoryFile(paths.workspaceContext, { authToken: token })
        : Promise.resolve({ path: '', exists: false, content: '' }),
    ]);

    return {
      globalPreferences: globalPreferences.content || '',
      globalContext: globalContext.content || '',
      workspacePreferences: workspacePreferences.content || '',
      workspaceContext: workspaceContext.content || '',
    };
  }

  async updateMemorySection(input: UpdateMemoryInput): Promise<UserMemoryView> {
    const targetPath = buildUserMemoryPath(input.scope, input.section, input.workspaceId);
    const token = this.buildMemoryToken(input.userId, input.workspaceId);
    const normalizedContent = String(input.content || '');
    if (normalizedContent.trim()) {
      await putInternalMemoryFile({ path: targetPath, content: normalizedContent }, { authToken: token });
    } else {
      await deleteInternalMemoryFile(targetPath, { authToken: token });
    }

    await this.db('user_memory_suggestions')
      .where({
        userId: input.userId,
        targetPath,
        status: 'pending',
      })
      .update({
        status: 'stale',
        reviewedAt: new Date().toISOString(),
        updatedAt: this.db.fn.now(),
      });

    return this.getMemoryView(input.userId, input.workspaceId);
  }

  async listSuggestions(userId: string, workspaceId?: string): Promise<UserMemorySuggestion[]> {
    const rows = await this.db('user_memory_suggestions')
      .where({ userId })
      .modify((query) => {
        if (workspaceId) {
          query.where((builder) => {
            builder.whereNull('workspaceId').orWhere('workspaceId', workspaceId);
          });
        }
      })
      .orderBy('createdAt', 'desc');

    return rows.map((row: any) => toSuggestionRow(row));
  }

  async decideSuggestion(
    userId: string,
    suggestionId: string,
    decision: 'accept' | 'reject',
    editedContent?: string,
  ): Promise<UserMemorySuggestion> {
    const row = await this.db('user_memory_suggestions').where({ id: suggestionId, userId }).first();
    if (!row) {
      throw new NotFoundError('Memory suggestion not found');
    }

    const suggestion = toSuggestionRow(row);
    const reviewedAt = new Date().toISOString();

    if (decision === 'reject') {
      const [updated] = await this.db('user_memory_suggestions')
        .where({ id: suggestionId })
        .update({
          status: 'rejected',
          reviewedAt,
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      return toSuggestionRow(updated);
    }

    const contentToWrite = editedContent !== undefined ? editedContent : suggestion.proposedContent;
    const token = this.buildMemoryToken(userId, suggestion.workspaceId || undefined);
    const currentFile = await getInternalMemoryFile(suggestion.targetPath, { authToken: token });
    const currentHash = hashContent(currentFile.content || '');
    if (currentHash !== suggestion.baseContentHash) {
      const [updated] = await this.db('user_memory_suggestions')
        .where({ id: suggestionId })
        .update({
          status: 'stale',
          reviewedAt,
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      throw new ConflictError('Memory file changed since this suggestion was created', {
        suggestion: toSuggestionRow(updated),
      });
    }

    if (contentToWrite.trim()) {
      await putInternalMemoryFile({ path: suggestion.targetPath, content: contentToWrite }, { authToken: token });
    } else {
      await deleteInternalMemoryFile(suggestion.targetPath, { authToken: token });
    }

    const [updated] = await this.db('user_memory_suggestions')
      .where({ id: suggestionId })
      .update({
        status: 'accepted',
        reviewedContent: contentToWrite,
        reviewedAt,
        updatedAt: this.db.fn.now(),
      })
      .returning('*');

    await this.db('user_memory_suggestions')
      .where({
        userId,
        targetPath: suggestion.targetPath,
        status: 'pending',
      })
      .andWhereNot({ id: suggestionId })
      .update({
        status: 'stale',
        reviewedAt,
        updatedAt: this.db.fn.now(),
      });

    return toSuggestionRow(updated);
  }

  async suggestForCompletedRun(input: SuggestForCompletedRunInput): Promise<void> {
    if (!input.userId || !input.conversationId) {
      return;
    }

    const conversation = await this.db('conversations')
      .where({ id: input.conversationId })
      .first();
    if (!conversation) {
      return;
    }
    const workspace = await this.db('workspaces')
      .select('name')
      .where({ id: input.workspaceId })
      .first();

    const messages = await this.db('conversation_messages')
      .where({ conversationId: input.conversationId })
      .orderBy('createdAt', 'asc');
    if (!messages.length) {
      return;
    }

    const transcript = messages
      .slice(-12)
      .map((message: any) => `${message.sender === 'agent' ? 'Agent' : 'User'}: ${String(message.text || '').trim()}`)
      .filter(Boolean)
      .join('\n');
    if (!transcript.trim()) {
      return;
    }

    const memoryView = await this.getMemoryView(input.userId, input.workspaceId);
    const candidatePaths = [
      buildUserMemoryPath('global', 'preferences'),
      buildUserMemoryPath('global', 'context'),
      buildUserMemoryPath('workspace', 'preferences', input.workspaceId),
      buildUserMemoryPath('workspace', 'context', input.workspaceId),
    ];

    const authToken = this.buildMemoryToken(input.userId, input.workspaceId);
    const analysis = await runInternalAnalysis(
      {
        systemPrompt: MEMORY_ANALYSIS_SYSTEM_PROMPT,
        userPrompt: [
          `Workspace name: ${workspace?.name || input.workspaceId}`,
          'Candidate target paths:',
          ...candidatePaths.map((path) => `- ${path}`),
          '',
          'Current memory files:',
          `- ${candidatePaths[0]}:\n${memoryView.globalPreferences || '(empty)'}`,
          `- ${candidatePaths[1]}:\n${memoryView.globalContext || '(empty)'}`,
          `- ${candidatePaths[2]}:\n${memoryView.workspacePreferences || '(empty)'}`,
          `- ${candidatePaths[3]}:\n${memoryView.workspaceContext || '(empty)'}`,
          '',
          'Recent conversation transcript:',
          transcript,
        ].join('\n'),
      },
      { authToken },
    );

    const rawCandidates = extractJsonArray(analysis.text);
    const seenPaths = new Set<string>();
    const candidates: MemorySuggestionCandidate[] = [];
    for (const item of rawCandidates) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const targetPath = String((item as Record<string, unknown>).targetPath || '').trim();
      const rationale = String((item as Record<string, unknown>).rationale || '').trim();
      const proposedContent = String((item as Record<string, unknown>).proposedContent || '').trim();
      if (!targetPath || !candidatePaths.includes(targetPath) || seenPaths.has(targetPath) || !rationale || !proposedContent) {
        continue;
      }
      seenPaths.add(targetPath);
      candidates.push({ targetPath, rationale, proposedContent });
    }

    for (const candidate of candidates) {
      const currentContent = await getInternalMemoryFile(candidate.targetPath, { authToken });
      if ((currentContent.content || '').trim() === candidate.proposedContent.trim()) {
        continue;
      }
      const described = describeUserMemoryPath(candidate.targetPath);
      await this.db('user_memory_suggestions')
        .where({
          userId: input.userId,
          targetPath: candidate.targetPath,
          status: 'pending',
        })
        .update({
          status: 'stale',
          reviewedAt: new Date().toISOString(),
          updatedAt: this.db.fn.now(),
        });

      await this.db('user_memory_suggestions').insert({
        id: uuidv4(),
        userId: input.userId,
        workspaceId: described.scope === 'workspace' ? described.workspaceId || input.workspaceId : null,
        sourceConversationId: input.conversationId,
        sourceRunId: input.runId,
        targetPath: candidate.targetPath,
        targetScope: described.scope,
        targetSection: described.section,
        baseContentHash: hashContent(currentContent.content || ''),
        proposedContent: candidate.proposedContent,
        rationale: candidate.rationale,
        status: 'pending',
        createdAt: this.db.fn.now(),
        updatedAt: this.db.fn.now(),
      });
    }
  }

  private buildMemoryToken(userId: string, workspaceId?: string): string | undefined {
    return signAgentContextToken({
      sub: userId,
      userId,
      workspaceId,
    }) || undefined;
  }
}

export function createEmptyUserMemoryView(): UserMemoryView {
  return emptyUserMemoryView();
}
