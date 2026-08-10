import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceRunLeaseManager } from '../src/services/agent-runs/workspaceRunLease';

class FakeRedisLeaseClient {
  strings = new Map<string, string>();
  statuses = new Map<string, string>();
  failRenew = false;

  async set(key: string, value: string): Promise<string | null> {
    if (this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async hGet(key: string): Promise<string | undefined> {
    return this.statuses.get(key);
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
    const [key, metaKey] = options.keys;
    const [token] = options.arguments;
    if (script.includes('PEXPIRE')) {
      if (this.failRenew) throw new Error('redis unavailable');
      const status = this.statuses.get(metaKey);
      return this.strings.get(key) === token && (status === 'queued' || status === 'running') ? 1 : 0;
    }
    if (this.strings.get(key) !== token) return 0;
    this.strings.delete(key);
    return 1;
  }
}

const metaKey = (runId: string) => `agent:run:${runId}:meta`;
const leaseKey = (workspaceId: string) => `agent-run:workspace-mutation:${workspaceId}`;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('workspace leases serialize contenders and release with the owner token', async () => {
  const redis = new FakeRedisLeaseClient();
  redis.statuses.set(metaKey('run-1'), 'queued');
  redis.statuses.set(metaKey('run-2'), 'queued');
  const manager = new WorkspaceRunLeaseManager(redis, { ttlMs: 100, renewMs: 50, retryMs: 1 });
  await manager.acquire('run-1', 'workspace', new AbortController());

  let secondAcquired = false;
  const second = manager.acquire('run-2', 'workspace', new AbortController()).then(() => {
    secondAcquired = true;
  });
  await wait(5);
  assert.equal(secondAcquired, false);
  await manager.release('run-1');
  await second;
  assert.equal(secondAcquired, true);
  await manager.release('run-2');
  assert.equal(redis.strings.has(leaseKey('workspace')), false);
});

test('a queued contender stops when another pod marks it cancelled', async () => {
  const redis = new FakeRedisLeaseClient();
  redis.statuses.set(metaKey('owner'), 'running');
  redis.statuses.set(metaKey('waiter'), 'queued');
  const manager = new WorkspaceRunLeaseManager(redis, { ttlMs: 100, renewMs: 50, retryMs: 1 });
  await manager.acquire('owner', 'workspace', new AbortController());
  const controller = new AbortController();
  const waiting = manager.acquire('waiter', 'workspace', controller);
  await wait(5);
  redis.statuses.set(metaKey('waiter'), 'cancelled');
  await assert.rejects(waiting, /cancelled while waiting/);
  assert.equal(controller.signal.aborted, true);
  await manager.release('owner');
});

test('renewal ownership loss aborts and blocks a stale commit', async () => {
  const redis = new FakeRedisLeaseClient();
  redis.statuses.set(metaKey('run'), 'running');
  const controller = new AbortController();
  const manager = new WorkspaceRunLeaseManager(redis, { ttlMs: 100, renewMs: 5, retryMs: 1 });
  await manager.acquire('run', 'workspace', controller);
  redis.strings.set(leaseKey('workspace'), 'another-owner');
  await wait(15);
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(manager.assertOwned('run'), /lock was lost/);
  await manager.release('run');
  assert.equal(redis.strings.get(leaseKey('workspace')), 'another-owner');
});

test('renewal errors fail closed instead of letting the old owner continue', async () => {
  const redis = new FakeRedisLeaseClient();
  redis.statuses.set(metaKey('run'), 'running');
  const controller = new AbortController();
  const manager = new WorkspaceRunLeaseManager(redis, { ttlMs: 100, renewMs: 5, retryMs: 1 });
  await manager.acquire('run', 'workspace', controller);
  redis.failRenew = true;
  await wait(15);
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(manager.assertOwned('run'), /lock was lost/);
  redis.failRenew = false;
  await manager.release('run');
});

test('release never deletes a lease now owned by another token', async () => {
  const redis = new FakeRedisLeaseClient();
  redis.statuses.set(metaKey('run'), 'running');
  const manager = new WorkspaceRunLeaseManager(redis, { ttlMs: 100, renewMs: 50, retryMs: 1 });
  await manager.acquire('run', 'workspace', new AbortController());
  redis.strings.set(leaseKey('workspace'), 'replacement-token');
  await manager.release('run');
  assert.equal(redis.strings.get(leaseKey('workspace')), 'replacement-token');
});
