import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationCompactor,
  KEEP_TOKENS,
  MAX_SUMMARIZE_INPUT_TOKENS,
  RECOMPACT_STEP_TOKENS,
  SUMMARY_PREFIX,
  activationTokens,
  applyStoredSummary,
  estimateTokens,
  hashEntries,
  planCompaction,
  type ConversationSummaryStore,
  type StoredConversationSummary,
} from '../src/services/conversationCompaction';
import type { AgentHistoryEntry } from '../src/services/agentService';

const ACTIVATION = 170000;

/** Alternating user/assistant turns; each message is about `tokens` tokens. */
function transcript(turns: number, tokens: number, from = 0): AgentHistoryEntry[] {
  const entries: AgentHistoryEntry[] = [];
  for (let turn = from; turn < from + turns; turn += 1) {
    entries.push({ role: 'user', content: `QUESTION-${turn} ` + 'q'.repeat(tokens * 4) });
    entries.push({ role: 'assistant', content: `ANSWER-${turn} ` + 'a'.repeat(tokens * 4) });
  }
  return entries;
}

function storedFor(history: AgentHistoryEntry[], coveredCount: number, version = 1): StoredConversationSummary {
  return {
    summary: '## Recent requests\nEarlier work',
    coveredCount,
    coveredHash: hashEntries(history.slice(0, coveredCount)),
    version,
  };
}

test('a chat below the trigger is sent exactly as before and never compacted', () => {
  const history = transcript(20, 3000); // ~120k tokens
  assert.ok(estimateTokens(history) < ACTIVATION);

  assert.equal(planCompaction(history, null, ACTIVATION), null);
  const result = applyStoredSummary(history, null);
  assert.equal(result.applied, false);
  assert.equal(result.history, history); // the same array, untouched
});

test('crossing the trigger summarizes whole turns and keeps the newest ~40k tokens verbatim', () => {
  const history = transcript(30, 3000); // ~180k tokens

  const plan = planCompaction(history, null, ACTIVATION);

  assert.ok(plan);
  assert.equal(plan.previousSummary, null);
  assert.equal(history[plan.coveredCount].role, 'user'); // the kept tail starts on a user turn
  assert.ok(estimateTokens(history.slice(plan.coveredCount)) <= KEEP_TOKENS);
  assert.equal(plan.coveredHash, hashEntries(history.slice(0, plan.coveredCount)));
  assert.equal(plan.entries[0].content.startsWith('QUESTION-0'), true);
});

test('a stored summary replaces the covered prefix and keeps every newer message', () => {
  const history = transcript(30, 3000);
  const coveredCount = 46;

  const result = applyStoredSummary(history, storedFor(history, coveredCount));

  assert.equal(result.applied, true);
  assert.ok(result.history[0].content.startsWith(SUMMARY_PREFIX));
  assert.deepEqual(result.history.slice(1), history.slice(coveredCount));
});

test('an edited or regenerated earlier message falls back to the full history', () => {
  const history = transcript(30, 3000);
  const stored = storedFor(history, 46);
  const edited = history.map((entry, index) => (index === 3 ? { ...entry, content: 'edited answer' } : entry));

  const result = applyStoredSummary(edited, stored);

  assert.equal(result.applied, false);
  assert.equal(result.history, edited);
  // ...and the next compaction rebuilds from scratch instead of extending the stale summary.
  const plan = planCompaction(edited.concat(transcript(2, 3000, 30)), stored, ACTIVATION);
  assert.ok(plan);
  assert.equal(plan.previousSummary, null);
});

test('a stored summary is extended only after enough new messages', () => {
  const history = transcript(30, 3000);
  const stored = storedFor(history, 46);

  // A few more turns: the uncovered part is still under KEEP + STEP.
  assert.equal(planCompaction(history.concat(transcript(4, 3000, 30)), stored, ACTIVATION), null);

  // Enough growth: extend incrementally from the stored summary.
  const grown = history.concat(transcript(Math.ceil(RECOMPACT_STEP_TOKENS / 6000) + 2, 3000, 30));
  const plan = planCompaction(grown, stored, ACTIVATION);
  assert.ok(plan);
  assert.equal(plan.previousSummary, stored.summary);
  assert.equal(plan.entries[0], grown[46]);
  assert.ok(plan.coveredCount > 46);
});

test('the latest user turn is always kept, even when it alone exceeds the keep budget', () => {
  const history = transcript(30, 3000).concat([
    { role: 'user', content: 'HUGE-PASTE ' + 'p'.repeat((KEEP_TOKENS + 5000) * 4) },
    { role: 'assistant', content: 'ok' },
  ]);

  const plan = planCompaction(history, null, ACTIVATION);

  assert.ok(plan);
  assert.ok(history[plan.coveredCount].content.startsWith('HUGE-PASTE'));
});

test('a leaked SESSION INTENT reply is not fed into the summary but stays covered', () => {
  const history = transcript(30, 3000);
  history[5] = {
    role: 'assistant',
    content: 'SESSION INTENT\nAwaiting the user\nSUMMARY\nNone\nARTIFACTS\nNone\nNEXT STEPS\nAwait',
  };

  const plan = planCompaction(history, null, ACTIVATION);

  assert.ok(plan);
  assert.ok(plan.coveredCount > 5);
  assert.equal(plan.entries.some((entry) => entry.content.startsWith('SESSION INTENT')), false);
  assert.equal(plan.coveredHash, hashEntries(history.slice(0, plan.coveredCount)));
});

test('HELPUDOC_SUMMARY_TRIGGER_TOKENS lowers the trigger; bad values keep 170000', () => {
  assert.equal(activationTokens({} as NodeJS.ProcessEnv), 170000);
  assert.equal(activationTokens({ HELPUDOC_SUMMARY_TRIGGER_TOKENS: '20000' } as NodeJS.ProcessEnv), 20000);
  assert.equal(activationTokens({ HELPUDOC_SUMMARY_TRIGGER_TOKENS: '0' } as NodeJS.ProcessEnv), 170000);
  assert.equal(activationTokens({ HELPUDOC_SUMMARY_TRIGGER_TOKENS: 'x' } as NodeJS.ProcessEnv), 170000);
});

// --- ConversationCompactor: storage, concurrency and failure handling ----------------

class MemoryStore implements ConversationSummaryStore {
  row: (StoredConversationSummary & { coveredTokens: number }) | null = null;
  failReads = false;

  async getConversationSummary() {
    if (this.failReads) throw new Error('database unavailable');
    return this.row ? { ...this.row } : null;
  }

  async saveConversationSummary(
    _conversationId: string,
    expectedVersion: number | null,
    value: { summary: string; coveredCount: number; coveredHash: string; coveredTokens: number },
  ) {
    const current = this.row ? this.row.version : null;
    if (current !== expectedVersion) return false;
    this.row = { ...value, version: (current || 0) + 1 };
    return true;
  }
}

const quietLogger = { info: () => {}, warn: () => {} };
const context = { userId: 'user-1', workspaceId: 'workspace-1' };

test('compaction saves a summary that the next run then uses', async () => {
  const store = new MemoryStore();
  const prompts: string[] = [];
  const compactor = new ConversationCompactor(store, async (input) => {
    prompts.push(input.userPrompt);
    return '## Recent requests\nStored';
  }, quietLogger);
  const history = transcript(30, 3000);

  assert.equal(await compactor.compact('c1', history, context), 'saved');
  assert.ok(prompts[0].includes('QUESTION-0'));

  const next = history.concat(transcript(1, 100, 30));
  const sent = await compactor.prepareHistory('c1', next);
  assert.ok(sent[0].content.startsWith(SUMMARY_PREFIX));
  assert.ok(estimateTokens(sent) < estimateTokens(next) / 2);
});

test('over-budget history retains early context and uncompacted turns across compactor instances', async () => {
  const history = transcript(85, 3000); // ~510k tokens; one summary call cannot cover it.
  const store = new MemoryStore();
  let calls = 0;
  const summarize = async ({ userPrompt }: { userPrompt: string }) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(userPrompt.includes('QUESTION-0 '));
      return 'Early decision: use template 2a';
    }
    assert.ok(userPrompt.includes('Early decision: use template 2a'));
    assert.ok(userPrompt.includes(`QUESTION-${firstCovered / 2} `));
    return 'Early decision: use template 2a; later details added';
  };

  const first = new ConversationCompactor(store, summarize, quietLogger);
  assert.equal(await first.compact('c1', history, context), 'saved');
  const firstCovered = store.row!.coveredCount;
  assert.ok(firstCovered > 0 && firstCovered < history.length);
  assert.equal(history[firstCovered].role, 'user');
  assert.ok(estimateTokens(history.slice(0, firstCovered)) <= MAX_SUMMARIZE_INPUT_TOKENS);
  assert.ok(estimateTokens(history.slice(0, firstCovered + 2)) > MAX_SUMMARIZE_INPUT_TOKENS);

  const reopened = new ConversationCompactor(store, summarize, quietLogger);
  const resumed = await reopened.prepareHistory('c1', history);
  assert.ok(resumed[0].content.includes('Early decision: use template 2a'));
  assert.deepEqual(resumed.slice(1), history.slice(firstCovered));

  assert.equal(await reopened.compact('c1', history, context), 'saved');
  const extended = await reopened.prepareHistory('c1', history);
  assert.ok(extended[0].content.includes('Early decision: use template 2a'));
  assert.ok(store.row!.coveredCount > firstCovered);
  assert.deepEqual(extended.slice(1), history.slice(store.row!.coveredCount));
  assert.equal(calls, 2);
});

test('an oversized first unprocessed turn skips persistence without advancing coverage', async () => {
  // The individual messages fit; their whole turn does not.
  const history = transcript(1, Math.floor(MAX_SUMMARIZE_INPUT_TOKENS / 2))
    .concat(transcript(30, 3000, 1));
  const store = new MemoryStore();
  const compactor = new ConversationCompactor(store, async () => assert.fail('must not summarize a partial turn'), quietLogger);

  assert.equal(planCompaction(history, null, ACTIVATION), null);
  assert.equal(await compactor.compact('c1', history, context), 'skipped');
  assert.equal(store.row, null);
  assert.equal(await compactor.prepareHistory('c1', history), history);
});

test('only one compaction runs per conversation at a time', async () => {
  const store = new MemoryStore();
  let release: () => void = () => {};
  const compactor = new ConversationCompactor(store, () => new Promise<string>((resolve) => {
    release = () => resolve('summary');
  }), quietLogger);
  const history = transcript(30, 3000);

  const first = compactor.compact('c1', history, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await compactor.compact('c1', history, context), 'busy');
  release();
  assert.equal(await first, 'saved');
});

test('a failed or empty summary keeps the previous state, and runs carry on', async () => {
  const store = new MemoryStore();
  const history = transcript(30, 3000);

  const failing = new ConversationCompactor(store, async () => {
    throw new Error('Gemini 500');
  }, quietLogger);
  assert.equal(await failing.compact('c1', history, context), 'failed');
  const empty = new ConversationCompactor(store, async () => '   ', quietLogger);
  assert.equal(await empty.compact('c1', history, context), 'failed');

  assert.equal(store.row, null);
  assert.equal(await failing.prepareHistory('c1', history), history);
});

test('a summary saved concurrently by another job is not overwritten', async () => {
  const store = new MemoryStore();
  const history = transcript(30, 3000);
  const compactor = new ConversationCompactor(store, async () => {
    store.row = { ...storedFor(history, 10, 7), coveredTokens: 1 }; // another job saves first
    return 'late summary';
  }, quietLogger);

  assert.equal(await compactor.compact('c1', history, context), 'skipped');
  assert.equal(store.row?.version, 7);
});

test('if the summary store fails, the run sends the full history', async () => {
  const store = new MemoryStore();
  store.failReads = true;
  const compactor = new ConversationCompactor(store, async () => 'unused', quietLogger);
  const history = transcript(30, 3000);

  assert.equal(await compactor.prepareHistory('c1', history), history);
  assert.equal(await compactor.compact('c1', history, context), 'failed');
});
