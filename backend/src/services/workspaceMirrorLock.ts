import crypto from 'crypto';
import type { Knex } from 'knex';

/**
 * Minimal structural types for the pg driver objects we use. We deliberately
 * avoid a hard dependency on @types/pg (not installed) and obtain the Pool
 * constructor from knex's own bundled pg driver at runtime.
 */
interface LockPoolClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(err?: unknown): void;
}
interface LockPool {
  connect(): Promise<LockPoolClient>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}
type LockPoolConstructor = new (config: Record<string, unknown>) => LockPool;

/**
 * Serializes on-disk workspace mirror mutations for a single workspace.
 *
 * The workspace directory under WORKSPACE_ROOT is a cache of the authoritative
 * Postgres + object-store state. Multiple independent writers touch it:
 *   - FileService.commitFileBuffer / createFile / deleteFile / rename write a
 *     single file's local mirror after their DB commit, materializing the file's
 *     CURRENT canonical version.
 *   - WorkspacePublicationService.replaceWorkspaceContent performs an atomic
 *     directory swap when applying a submitted change set.
 *   - WorkspacePublicationService.rebuildWorkspaceMirror re-materializes the
 *     whole mirror from authoritative state after an apply failure.
 *
 * Without a shared boundary, a rebuild or delayed writer can read authoritative
 * content, a concurrent writer/apply can then commit newer accepted bytes, and
 * the slower mirror mutation silently overwrites them.
 *
 * This helper takes a session-level Postgres advisory lock keyed on the
 * workspace id, held for the full duration of the supplied operation.
 *
 * CONNECTION POOLING: the advisory lock and its matching unlock must run on the
 * SAME physical connection, held for the whole critical section. Taking that
 * connection from the application's main data pool is unsafe: the callback
 * itself needs data-pool connections (e.g. to read canonical state or run the
 * apply transaction), so N concurrent lock holders can reserve every data-pool
 * connection and then deadlock waiting for one more. To avoid this we use a
 * SEPARATE, dedicated connection pool exclusively for advisory locks. Lock
 * connections therefore never contend with the callback's data-pool usage.
 */
const MIRROR_LOCK_NAMESPACE = 'workspace-mirror';

function isPostgres(db: Knex): boolean {
  const client = (db as any)?.client?.config?.client;
  return client === 'pg' || client === 'postgresql' || client === 'postgres';
}

// One dedicated advisory-lock pool per distinct connection configuration. In
// practice there is a single database, so this holds a single small pool. Keyed
// by a stable hash of the resolved connection config.
const lockPools = new Map<string, LockPool>();

function toPoolConfig(connection: unknown): Record<string, unknown> {
  if (typeof connection === 'string') {
    return { connectionString: connection };
  }
  if (connection && typeof connection === 'object') {
    const conn = connection as Record<string, unknown>;
    if (typeof conn.connectionString === 'string') {
      return { connectionString: conn.connectionString, ssl: conn.ssl };
    }
    return {
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ssl: conn.ssl,
    };
  }
  throw new Error('workspaceMirrorLock: unable to derive a Postgres connection config');
}

function getPoolConstructor(db: Knex): LockPoolConstructor {
  // knex's pg client exposes the bundled pg driver; reuse it so we do not add a
  // separate pg dependency or type package.
  const driver = (db as any)?.client?.driver;
  if (!driver?.Pool) {
    throw new Error('workspaceMirrorLock: pg driver Pool is unavailable');
  }
  return driver.Pool as LockPoolConstructor;
}

function getLockPool(db: Knex): LockPool {
  const connection = (db as any)?.client?.config?.connection;
  const key = crypto.createHash('sha256').update(JSON.stringify(connection ?? {})).digest('hex');
  let pool = lockPools.get(key);
  if (!pool) {
    const Pool = getPoolConstructor(db);
    const config = toPoolConfig(connection);
    // A small dedicated pool. Concurrent lock holders wait for a lock-pool
    // connection (bounded back-pressure) rather than starving the data pool.
    pool = new Pool({ ...config, max: 8, idleTimeoutMillis: 30_000 });
    // Never let a background pool error crash the process; individual acquisitions
    // surface their own errors.
    pool.on('error', () => undefined);
    lockPools.set(key, pool);
  }
  return pool;
}

export async function withWorkspaceMirrorLock<T>(
  db: Knex,
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withAdvisoryLock(db, MIRROR_LOCK_NAMESPACE, workspaceId, operation);
}

/**
 * Generalized session-level Postgres advisory lock, keyed by (namespace, key),
 * held on a dedicated lock-pool connection for the full duration of `operation`.
 *
 * This is the same mechanism `withWorkspaceMirrorLock` uses (that function is now
 * a thin wrapper preserving its `workspace-mirror` namespace and behavior). Other
 * subsystems that must serialize a cross-process critical section — e.g. the team
 * chat per-source dispatch handoff — pass their own namespace so their lock space
 * never collides with the mirror lock.
 */
export async function withAdvisoryLock<T>(
  db: Knex,
  namespace: string,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!isPostgres(db)) {
    // Advisory locks are Postgres-specific. Fall back to running the operation
    // directly so non-pg test databases keep working; production uses pg.
    return operation();
  }

  const digest = crypto.createHash('sha256')
    .update(`${namespace}\0${key}`)
    .digest();
  const lockKeys = [digest.readInt32BE(0), digest.readInt32BE(4)];

  const pool = getLockPool(db);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', lockKeys);
    locked = true;
    return await operation();
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', lockKeys).catch(() => undefined);
    }
    client.release();
  }
}

/**
 * Close all dedicated lock pools. Intended for graceful shutdown / test cleanup.
 */
export async function closeWorkspaceMirrorLockPools(): Promise<void> {
  const pools = Array.from(lockPools.values());
  lockPools.clear();
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
}
