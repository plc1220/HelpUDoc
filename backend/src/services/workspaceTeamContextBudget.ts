/**
 * Shared budget/overhead constants for the Team Chat (F3) context stage.
 *
 * The 24k budget must constrain the ACTUAL serialized runner input — the fixed
 * prompt scaffold, the source question, rendered reference metadata, the quote
 * notice, the truncation notice, and every serialized history message — not just
 * a manifest label. buildThreadContext (the selector) and
 * WorkspaceTeamChatAgentService.prepare (the serializer) both import these
 * constants so the budget the selector enforces matches the prompt the runner
 * actually receives.
 */

/** Default input budget in characters (~4 chars/token). */
export const TEAM_CONTEXT_CHAR_BUDGET = 24_000;

/** The context-builder version recorded with each run for retry reproducibility. */
export const TEAM_CONTEXT_BUILDER_VERSION = 'thread-ctx-v3';

/**
 * Bounded history page size. buildThreadContext fetches at most this many
 * messages via a descending LIMIT query plus explicit root/quote lookups; it
 * never scans the whole thread. Sized comfortably above the number of messages
 * that can fit in the budget so the fill loop is the binding constraint.
 */
export const TEAM_CONTEXT_HISTORY_PAGE = 400;

/**
 * Fixed size of the instruction scaffold prepare() always emits (the constant
 * instruction lines joined by blank lines, the "Question from " label, and the
 * read/write instruction). Measured against the longest branch so the estimate
 * never under-counts the real prompt. A conservative constant is intentional:
 * over-counting keeps the runner input strictly under budget.
 */
export const TEAM_PROMPT_SCAFFOLD_CHARS = 1_600;

/** Reserved characters for the truncation/history-reader notice when present. */
export const TRUNCATION_NOTICE_CHARS = 600;

/** Reserved characters for the quote-notice line when a quote is present. */
export const QUOTE_NOTICE_CHARS = 560;

/** Per-message structural overhead in the serialized agentHistory array. */
export const HISTORY_MESSAGE_OVERHEAD_CHARS = 16;

/**
 * Rendered cost of one resolved file reference in the prompt's "Referenced
 * files" section (a JSON line with name, version label, and system path).
 */
export const REFERENCE_LINE_CHARS = 220;

/** Total reference-section overhead for a given number of resolved references. */
export function referenceOverheadChars(referenceCount: number): number {
  if (referenceCount <= 0) return 0;
  // Section header + one rendered line per reference.
  return 80 + referenceCount * REFERENCE_LINE_CHARS;
}
