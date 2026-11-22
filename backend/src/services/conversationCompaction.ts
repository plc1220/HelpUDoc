import { createHash } from 'crypto';
import type { AgentHistoryEntry } from './agentService';

/**
 * Stored memory for long workspace chats.
 *
 * Every run sends the whole visible transcript to the agent. Past the agent's
 * summarization trigger, SummarizationMiddleware summarized it again on every turn and
 * threw the result away. This keeps one summary per conversation in Postgres instead:
 * runs send "summary + newer messages", and a background job extends the summary after
 * a run starts. Users see nothing of this; the full transcript stays in
 * conversation_messages and on screen.
 *
 * Shorter chats must behave exactly as before (they are what UAT validated). A summary
 * is first created only when the transcript reaches the same trigger at which the agent
 * already summarizes, so every conversation this changes was already being summarized.
 *
 * A summary covers a prefix of the history the frontend sends, identified by its length
 * and a hash. If an edit or regenerate changes that prefix, the hash no longer matches,
 * the run sends the full history as before, and the next compaction rebuilds it.
 */

export const DEFAULT_ACTIVATION_TOKENS = 170000;
/** Newest history left verbatim after the summary. Matches SUMMARY_KEEP_TOKENS in the agent. */
export const KEEP_TOKENS = 40000;
/** New messages beyond KEEP_TOKENS before the summary is extended again. */
export const RECOMPACT_STEP_TOKENS = 60000;
/** Upper bound on transcript entries sent in one summary call. */
export const MAX_SUMMARIZE_INPUT_TOKENS = 300000;
/** Same wording as LangChain's summary message, which the agent already handles. */
export const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:\n\n';

export type StoredConversationSummary = {
  summary: string;
  coveredCount: number;
  coveredHash: string;
  version: number;
};

export type CompactionPlan = {
  previousSummary: string | null;
  entries: AgentHistoryEntry[];
  coveredCount: number;
  coveredHash: string;
  coveredTokens: number;
};

/** The agent's trigger. HELPUDOC_SUMMARY_TRIGGER_TOKENS lowers both on a test cluster. */
export function activationTokens(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(String(env.HELPUDOC_SUMMARY_TRIGGER_TOKENS || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ACTIVATION_TOKENS;
}

/** Same estimate as LangChain's count_tokens_approximately: 4 characters a token, plus 3 a message. */
export function estimateTokens(entries: AgentHistoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + Math.ceil(String(entry.content || '').length / 4) + 3, 0);
}

export function hashEntries(entries: AgentHistoryEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.role, entry.content]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function storedSummaryMatches(history: AgentHistoryEntry[], stored: StoredConversationSummary | null): boolean {
  return Boolean(
    stored
      && stored.summary.trim()
      && stored.coveredCount > 0
      && history.length >= stored.coveredCount
      && hashEntries(history.slice(0, stored.coveredCount)) === stored.coveredHash,
  );
}

/** History to send for this run. Unchanged unless a stored summary covers its prefix. */
export function applyStoredSummary(
  history: AgentHistoryEntry[],
  stored: StoredConversationSummary | null,
): { history: AgentHistoryEntry[]; applied: boolean } {
  if (!stored || !storedSummaryMatches(history, stored)) {
    return { history, applied: false };
  }
  return {
    history: [{ role: 'user', content: `${SUMMARY_PREFIX}${stored.summary.trim()}` }, ...history.slice(stored.coveredCount)],
    applied: true,
  };
}

/**
 * The index where the kept tail starts: the earliest user message whose tail fits in
 * KEEP_TOKENS. Cutting at a user message keeps whole turns on each side. Returns 0 when
 * no cut fits after `notBefore`.
 */
function findCut(history: AgentHistoryEntry[], notBefore: number): number {
  let tailTokens = 0;
  let cut = 0;
  for (let index = history.length - 1; index > notBefore; index -= 1) {
    tailTokens += estimateTokens([history[index]]);
    if (tailTokens > KEEP_TOKENS) {
      break;
    }
    if (history[index].role === 'user') {
      cut = index;
    }
  }
  // Keep at least the latest user turn, even when it alone exceeds KEEP_TOKENS.
  if (!cut) {
    for (let index = history.length - 1; index > notBefore; index -= 1) {
      if (history[index].role === 'user') {
        return index;
      }
    }
  }
  return cut;
}

/** A leaked "SESSION INTENT / SUMMARY / ARTIFACTS / NEXT STEPS" reply from before the #121 fix. */
export function isLeakedSummaryReply(entry: AgentHistoryEntry): boolean {
  if (entry.role !== 'assistant') return false;
  const text = String(entry.content || '');
  return ['SESSION INTENT', 'SUMMARY', 'ARTIFACTS', 'NEXT STEPS'].every((heading) => text.includes(heading))
    && text.trimStart().startsWith('SESSION INTENT');
}

/** Whether to (re)build the summary for this history, and from what. */
export function planCompaction(
  history: AgentHistoryEntry[],
  stored: StoredConversationSummary | null,
  activation: number = activationTokens(),
): CompactionPlan | null {
  const matches = storedSummaryMatches(history, stored);
  const start = matches && stored ? stored.coveredCount : 0;
  if (matches) {
    if (estimateTokens(history.slice(start)) < KEEP_TOKENS + RECOMPACT_STEP_TOKENS) {
      return null;
    }
  } else if (estimateTokens(history) < activation) {
    return null;
  }

  const cut = findCut(history, start);
  if (cut <= start) {
    return null;
  }
  // Coverage must be a contiguous prefix. Stop at the last complete turn within
  // budget; any remaining turns stay verbatim and can be summarized on a later run.
  let coveredCount = start;
  let inputTokens = 0;
  const candidates: AgentHistoryEntry[] = [];
  let coveredEntryCount = 0;
  for (let index = start; index < cut; index += 1) {
    const entry = history[index];
    if (index > start && entry.role === 'user') {
      coveredCount = index;
      coveredEntryCount = candidates.length;
    }
    if (!isLeakedSummaryReply(entry)) {
      inputTokens += estimateTokens([entry]);
      if (inputTokens > MAX_SUMMARIZE_INPUT_TOKENS) break;
      candidates.push(entry);
    }
    if (index === cut - 1) {
      coveredCount = cut;
      coveredEntryCount = candidates.length;
    }
  }
  // An oversized first unprocessed turn cannot be skipped by a prefix summary.
  if (!coveredEntryCount) {
    return null;
  }
  return {
    previousSummary: matches && stored ? stored.summary : null,
    entries: candidates.slice(0, coveredEntryCount),
    coveredCount,
    coveredHash: hashEntries(history.slice(0, coveredCount)),
    coveredTokens: estimateTokens(history.slice(0, coveredCount)),
  };
}

// Keep the sections in step with LUMO_SUMMARY_PROMPT in
// agent/helpudoc_agent/runtime/summarization.py, which summarizes inside a run.
export const COMPACTION_SYSTEM_PROMPT = `You maintain the running summary of a Lumo conversation so the assistant can keep working.
Your summary replaces the earlier messages in the assistant's context. The user never sees it.
Do not answer the user or continue the task; only record context.

You receive the current summary (it may be empty) and the next part of the conversation.
Write one updated summary that replaces both. Keep everything from the current summary that
is still relevant, and add what the new messages contain.

Write in the user's language. Keep exact file paths, template and skill names, IDs, table
names, figures and dates. Do not invent anything. Write "None" only when there is truly
nothing for that section.

## Recent requests
The user's requests in order, the latest quoted verbatim, and what a complete answer to each needed.

## Goal of the conversation
The overall task across all turns, in one or two sentences.

## Workspace files and templates
Every file, folder, template or dashboard that was read, created or changed, with its path
and one line on its role.

## Decisions and preferences
What the user chose, approved or rejected, and why. Formatting, tone and structure
preferences. Plan or action approvals that were given.

## Data and findings
Sources used (BigQuery tables, MCP tools, uploaded documents, web) and the key results,
numbers and conclusions, with the query or file each came from.

## Open items
Questions waiting for the user, pending approvals, failed steps and their errors, and what
remains to be done next.

Respond only with the sections above.`;

export function buildCompactionUserPrompt(plan: CompactionPlan): string {
  const transcript = plan.entries
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`)
    .join('\n\n');
  return [
    '<current_summary>',
    plan.previousSummary?.trim() || '(none)',
    '</current_summary>',
    '',
    '<next_messages>',
    transcript,
    '</next_messages>',
  ].join('\n');
}

export type ConversationSummaryStore = {
  getConversationSummary(conversationId: string): Promise<StoredConversationSummary | null>;
  /** Writes only if the row still has `expectedVersion` (null: no row). Returns false otherwise. */
  saveConversationSummary(
    conversationId: string,
    expectedVersion: number | null,
    value: { summary: string; coveredCount: number; coveredHash: string; coveredTokens: number },
  ): Promise<boolean>;
};

export type Summarize = (
  input: { systemPrompt: string; userPrompt: string },
  context: { userId: string; workspaceId: string },
) => Promise<string>;

type Logger = Pick<Console, 'info' | 'warn'>;

export class ConversationCompactor {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: ConversationSummaryStore,
    private readonly summarize: Summarize,
    private readonly logger: Logger = console,
  ) {}

  /** History to send. Any failure falls back to the history as given. */
  async prepareHistory(conversationId: string, history: AgentHistoryEntry[]): Promise<AgentHistoryEntry[]> {
    try {
      const stored = await this.store.getConversationSummary(conversationId);
      return applyStoredSummary(history, stored).history;
    } catch (error) {
      this.logger.warn('Conversation summary unavailable; sending the full history', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return history;
    }
  }

  /** Extends the stored summary if needed. Never throws; one job per conversation at a time. */
  async compact(
    conversationId: string,
    history: AgentHistoryEntry[],
    context: { userId: string; workspaceId: string },
  ): Promise<'saved' | 'skipped' | 'busy' | 'failed'> {
    if (this.inFlight.has(conversationId)) {
      return 'busy';
    }
    this.inFlight.add(conversationId);
    try {
      const stored = await this.store.getConversationSummary(conversationId);
      const plan = planCompaction(history, stored);
      if (!plan) {
        return 'skipped';
      }
      const summary = (
        await this.summarize(
          { systemPrompt: COMPACTION_SYSTEM_PROMPT, userPrompt: buildCompactionUserPrompt(plan) },
          context,
        )
      ).trim();
      if (!summary) {
        this.logger.warn('Conversation compaction returned an empty summary; keeping the previous one', { conversationId });
        return 'failed';
      }
      const saved = await this.store.saveConversationSummary(conversationId, stored ? stored.version : null, {
        summary,
        coveredCount: plan.coveredCount,
        coveredHash: plan.coveredHash,
        coveredTokens: plan.coveredTokens,
      });
      this.logger.info('Conversation compaction', {
        conversationId,
        result: saved ? 'saved' : 'superseded',
        coveredMessages: plan.coveredCount,
        coveredTokens: plan.coveredTokens,
        incremental: Boolean(plan.previousSummary),
      });
      return saved ? 'saved' : 'skipped';
    } catch (error) {
      this.logger.warn('Conversation compaction failed; runs keep the previous summary', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    } finally {
      this.inFlight.delete(conversationId);
    }
  }
}

// --- Archive of earlier messages, searchable by the agent within one run ---------------
//
// Governance: built only from rows returned by
// ConversationService.listConversationArchiveSource, which applies the same checks as
// opening the conversation (workspace membership and conversation creator). Never built
// from anything the browser sends. Passed to the agent with the run, never persisted.

/** Below this the whole history is in the model's context, so no archive is needed. */
export const ARCHIVE_MIN_HISTORY_TOKENS = 80000;
/** Upper bound on archived history per run (the newest older messages are kept). */
export const ARCHIVE_MAX_TOKENS = 300000;

export type ConversationArchiveSourceRow = {
  id: number | string;
  sender: string;
  text: string | null;
  createdAt: Date | string;
  bodySource?: string | null;
};

export type ConversationArchiveMessage = {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string;
  content: string;
};

export type ConversationArchive = {
  conversationId: string;
  truncated: boolean;
  messages: ConversationArchiveMessage[];
};

/** Earlier messages that the model may no longer see, oldest first. Null when not needed. */
export function buildConversationArchive(
  conversationId: string,
  rows: ConversationArchiveSourceRow[],
): ConversationArchive | null {
  // Same filter as the history the frontend sends (mapMessagesToAgentHistory).
  const messages: ConversationArchiveMessage[] = rows
    .filter((row) => typeof row.text === 'string' && row.text.trim().length > 0)
    .filter((row) => !(row.sender === 'agent' && row.bodySource === 'summary'))
    .map((row) => ({
      id: String(row.id),
      role: row.sender === 'agent' ? ('assistant' as const) : ('user' as const),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      content: String(row.text).trim(),
    }));
  if (estimateTokens(messages) < ARCHIVE_MIN_HISTORY_TOKENS) {
    return null;
  }
  // The newest ~KEEP_TOKENS stay in the model's context; archive what is older.
  let tail = 0;
  let split = messages.length;
  while (split > 0) {
    const next = estimateTokens([messages[split - 1]]);
    if (tail + next > KEEP_TOKENS) break;
    tail += next;
    split -= 1;
  }
  const older = messages.slice(0, split);
  let budget = 0;
  let start = older.length;
  while (start > 0) {
    const next = estimateTokens([older[start - 1]]);
    if (budget + next > ARCHIVE_MAX_TOKENS) break;
    budget += next;
    start -= 1;
  }
  if (!older.length) {
    return null;
  }
  return { conversationId, truncated: start > 0, messages: older.slice(start) };
}
