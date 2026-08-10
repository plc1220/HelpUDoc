import { randomUUID } from 'crypto';

type RedisLeaseClient = {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

type HeldLease = {
  key: string;
  token: string;
  renewal: NodeJS.Timeout;
  controller: AbortController;
  lost: boolean;
};

const activeStatus = (status: string | null | undefined) => status === 'queued' || status === 'running';
const metaKey = (runId: string) => `agent:run:${runId}:meta`;
const leaseKey = (workspaceId: string) => `agent-run:workspace-mutation:${workspaceId}`;

export class WorkspaceRunLeaseManager {
  private readonly held = new Map<string, HeldLease>();

  constructor(
    private readonly redis: RedisLeaseClient,
    private readonly options: { ttlMs?: number; renewMs?: number; retryMs?: number } = {},
  ) {}

  private get ttlMs() { return this.options.ttlMs ?? 90_000; }
  private get renewMs() { return this.options.renewMs ?? 30_000; }
  private get retryMs() { return this.options.retryMs ?? 250; }

  private lose(runId: string, token: string): void {
    const lease = this.held.get(runId);
    if (!lease || lease.token !== token) return;
    lease.lost = true;
    clearInterval(lease.renewal);
    if (!lease.controller.signal.aborted) lease.controller.abort();
  }

  async acquire(runId: string, workspaceId: string, controller: AbortController): Promise<void> {
    const key = leaseKey(workspaceId);
    const token = `${runId}:${randomUUID()}`;
    while (!controller.signal.aborted) {
      const status = await this.redis.hGet(metaKey(runId), 'status');
      if (!activeStatus(status)) {
        controller.abort();
        break;
      }
      const acquired = await this.redis.set(key, token, { NX: true, PX: this.ttlMs });
      if (acquired === 'OK') {
        const renewal = setInterval(() => {
          void this.redis.eval(
            'local status = redis.call("HGET", KEYS[2], "status"); '
              + 'if redis.call("GET", KEYS[1]) == ARGV[1] and (status == "queued" or status == "running") '
              + 'then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end',
            { keys: [key, metaKey(runId)], arguments: [token, String(this.ttlMs)] },
          ).then((renewed) => {
            if (Number(renewed) !== 1) this.lose(runId, token);
          }).catch(() => this.lose(runId, token));
        }, this.renewMs);
        renewal.unref?.();
        this.held.set(runId, { key, token, renewal, controller, lost: false });
        try {
          await this.assertOwned(runId);
        } catch (error) {
          this.lose(runId, token);
          throw error;
        }
        return;
      }
      await new Promise((resolve) => setTimeout(
        resolve,
        this.retryMs + Math.floor(Math.random() * this.retryMs),
      ));
    }
    throw new Error('Agent run cancelled while waiting for the workspace execution lock');
  }

  async assertOwned(runId: string): Promise<void> {
    const lease = this.held.get(runId);
    if (!lease || lease.lost || lease.controller.signal.aborted) {
      throw new Error('Workspace execution lock was lost');
    }
    const [token, status] = await Promise.all([
      this.redis.get(lease.key),
      this.redis.hGet(metaKey(runId), 'status'),
    ]);
    if (token !== lease.token) {
      this.lose(runId, lease.token);
      throw new Error('Workspace execution lock was lost');
    }
    if (!activeStatus(status)) {
      this.lose(runId, lease.token);
      throw new Error(`Agent run cannot own workspace files while status is ${status}`);
    }
  }

  async release(runId: string): Promise<void> {
    const lease = this.held.get(runId);
    if (!lease) return;
    this.held.delete(runId);
    clearInterval(lease.renewal);
    await this.redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      { keys: [lease.key], arguments: [lease.token] },
    );
  }
}
