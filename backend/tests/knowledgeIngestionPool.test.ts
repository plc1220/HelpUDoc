import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeIngestionPool } from '../src/workers/knowledgeIngestionPool';

type Job = { id: string };

/** A run that ends only when the test says so. */
const controllable = () => {
  const runs = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const run = (job: Job) => new Promise<void>((resolve, reject) => { runs.set(job.id, { resolve, reject }); });
  return { runs, run };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a free slot is refilled without waiting for the other running build', async () => {
  const queue: Job[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const claims: Array<{ limit: number; exclude: string[] }> = [];
  const { runs, run } = controllable();
  const pool = new KnowledgeIngestionPool<Job>({
    concurrency: 2,
    claim: async (limit, exclude) => {
      claims.push({ limit, exclude });
      return queue.filter((job) => !exclude.includes(job.id)).slice(0, limit);
    },
    run,
    onError: () => undefined,
  });

  assert.equal(await pool.fill(), 2);
  assert.deepEqual([...runs.keys()], ['a', 'b']);

  // The old worker awaited the whole batch here; 'c' waited for both 'a' and 'b'.
  runs.get('a')!.resolve();
  queue.splice(0, 1);
  await pool.waitForSlot(1_000);
  await flush();
  assert.equal(await pool.fill(), 1);
  assert.deepEqual([...runs.keys()], ['a', 'b', 'c']);
  assert.deepEqual(claims.at(-1), { limit: 1, exclude: ['b'] });

  runs.get('b')!.resolve();
  runs.get('c')!.resolve();
  await pool.drain();
  assert.equal(pool.size, 0);
});

test('a running build is never claimed twice', async () => {
  const { runs, run } = controllable();
  let started = 0;
  const pool = new KnowledgeIngestionPool<Job>({
    concurrency: 2,
    // A stale read that still returns the running job must not start a second copy.
    claim: async () => [{ id: 'a' }, { id: 'a' }],
    run: (job) => { started += 1; return run(job); },
    onError: () => undefined,
  });
  await pool.fill();
  await pool.fill();
  assert.equal(started, 1);
  runs.get('a')!.resolve();
  await pool.drain();
});

test('a full pool does not query for more work', async () => {
  const { runs, run } = controllable();
  let claimCalls = 0;
  const pool = new KnowledgeIngestionPool<Job>({
    concurrency: 1,
    claim: async () => { claimCalls += 1; return [{ id: 'a' }]; },
    run,
    onError: () => undefined,
  });
  await pool.fill();
  assert.equal(await pool.fill(), 0);
  assert.equal(claimCalls, 1);
  runs.get('a')!.resolve();
  await pool.drain();
});

test('one failed build is reported and does not stop the others', async () => {
  const { runs, run } = controllable();
  const failures: string[] = [];
  const pool = new KnowledgeIngestionPool<Job>({
    concurrency: 2,
    claim: async (limit) => [{ id: 'a' }, { id: 'b' }].slice(0, limit),
    run,
    onError: (job, error) => failures.push(`${job.id}: ${(error as Error).message}`),
  });
  await pool.fill();
  runs.get('a')!.reject(new Error('timeout of 300000ms exceeded'));
  await pool.waitForSlot(1_000);
  await flush();
  assert.deepEqual(failures, ['a: timeout of 300000ms exceeded']);
  assert.equal(pool.size, 1);
  runs.get('b')!.resolve();
  await pool.drain();
  assert.equal(pool.size, 0);
});

test('waiting for a slot gives up after the poll interval when nothing ends', async () => {
  const { runs, run } = controllable();
  const pool = new KnowledgeIngestionPool<Job>({
    concurrency: 1,
    claim: async () => [{ id: 'a' }],
    run,
    onError: () => undefined,
  });
  await pool.fill();
  const startedAt = Date.now();
  await pool.waitForSlot(30);
  assert.ok(Date.now() - startedAt >= 25);
  runs.get('a')!.resolve();
  await pool.drain();
});
