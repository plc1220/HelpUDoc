/**
 * Keeps up to `concurrency` knowledge ingestion runs going at once.
 *
 * The worker used to claim a batch and await all of it before claiming again, so a
 * free slot sat idle until the slowest run in the batch finished. On 2026-10-16 two
 * files waited 8.6 minutes behind a run that was timing out, though each needed only
 * two or three minutes of work. Here a slot is refilled as soon as its run ends.
 */
export type IngestionPoolDeps<Job extends { id: unknown }> = {
  concurrency: number;
  claim: (limit: number, excludeRunIds: string[]) => Promise<Job[]>;
  run: (job: Job) => Promise<void>;
  onError: (job: Job, error: unknown) => void;
};

export class KnowledgeIngestionPool<Job extends { id: unknown }> {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: IngestionPoolDeps<Job>) {}

  get size(): number {
    return this.running.size;
  }

  /** Start runs for every free slot. Returns how many were started. */
  async fill(): Promise<number> {
    const free = this.deps.concurrency - this.running.size;
    if (free < 1) return 0;
    const jobs = await this.deps.claim(free, [...this.running.keys()]);
    let started = 0;
    for (const job of jobs) {
      const runId = String(job.id);
      if (this.running.has(runId) || this.running.size >= this.deps.concurrency) continue;
      // One run's failure is that run's alone: it is logged here and never rejects the
      // loop, which used to abandon the rest of the batch with it.
      const execution = this.deps.run(job)
        .catch((error) => this.deps.onError(job, error))
        .finally(() => { this.running.delete(runId); });
      this.running.set(runId, execution);
      started += 1;
    }
    return started;
  }

  /** Resolve when any run ends, or after `timeoutMs`, whichever is first. */
  async waitForSlot(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([timeout, ...this.running.values()]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }
}
