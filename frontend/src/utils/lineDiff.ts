/**
 * Self-contained line-level diff (LCS) used by the Release B Changes view and
 * proposal review.
 *
 * We implement our own diff rather than adding the `diff` npm package: it is
 * only a transitive dependency today, and adding a new direct dependency to
 * this repo is out of scope for the bounded Release B frontend stage. A simple
 * O(n·m) LCS over lines is more than sufficient for reviewing human/agent file
 * edits and keeps the build hermetic.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number in the "before" text (null for pure inserts). */
  beforeLine: number | null;
  /** 1-based line number in the "after" text (null for pure deletes). */
  afterLine: number | null;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the two inputs are byte-identical. */
  identical: boolean;
  /** True when the inputs differ ONLY in line endings / trailing newline, so
   *  the line-level view shows no add/remove but the bytes are not identical. */
  whitespaceOnly: boolean;
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  // Normalize CRLF/CR so line matching is not defeated by line-ending drift.
  const normalized = value.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // A trailing newline produces a final empty element we should drop, so the
  // diff does not report a spurious blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '' && normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/**
 * Compute a line-level diff between `before` and `after`. Guards against
 * pathological inputs by capping the LCS table size; beyond the cap it falls
 * back to a whole-block replace (still correct, just coarser) so the UI never
 * hangs on a huge file.
 */
export function diffLines(before: string, after: string): DiffResult {
  if (before === after) {
    const lines = splitLines(before).map<DiffLine>((text, i) => ({
      op: 'equal',
      beforeLine: i + 1,
      afterLine: i + 1,
      text,
    }));
    return { lines, added: 0, removed: 0, identical: true, whitespaceOnly: false };
  }

  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  const MAX_CELLS = 4_000_000; // ~ (2000 x 2000) lines; beyond → coarse replace.
  if (n * m > MAX_CELLS) {
    const lines: DiffLine[] = [
      ...a.map<DiffLine>((text, i) => ({ op: 'delete', beforeLine: i + 1, afterLine: null, text })),
      ...b.map<DiffLine>((text, i) => ({ op: 'insert', beforeLine: null, afterLine: i + 1, text })),
    ];
    return { lines, added: m, removed: n, identical: false, whitespaceOnly: false };
  }

  // Classic LCS dynamic-programming table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ op: 'equal', beforeLine: i + 1, afterLine: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ op: 'delete', beforeLine: i + 1, afterLine: null, text: a[i] });
      removed += 1;
      i += 1;
    } else {
      lines.push({ op: 'insert', beforeLine: null, afterLine: j + 1, text: b[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ op: 'delete', beforeLine: i + 1, afterLine: null, text: a[i] });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    lines.push({ op: 'insert', beforeLine: null, afterLine: j + 1, text: b[j] });
    added += 1;
    j += 1;
  }

  // The line-level view found no add/remove but the raw strings differ → the
  // difference is only in line endings / trailing newline. Report it honestly.
  const whitespaceOnly = added === 0 && removed === 0;
  return { lines, added, removed, identical: false, whitespaceOnly };
}

/** Human-readable "+N −M" summary. Honest about a line-ending-only difference
 *  and about byte-identical content. */
export function diffSummary(result: DiffResult): string {
  if (result.identical) return 'No changes';
  if (result.whitespaceOnly) return 'Line endings / trailing newline differ only';
  const parts: string[] = [];
  if (result.added) parts.push(`+${result.added}`);
  if (result.removed) parts.push(`\u2212${result.removed}`);
  return parts.join(' ') || 'Changed';
}
