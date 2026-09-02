import crypto from 'crypto';
import type { Knex } from 'knex';

/**
 * The advisory-lock key pair for a resource.
 *
 * Shared so a caller already inside a transaction can take the *same* lock with
 * `pg_advisory_xact_lock`, rather than `withGovernanceLock`, which acquires its
 * own connection and so cannot join one.
 */
export function governanceLockKeys(namespace: string, resourceId: string): [number, number] {
  const digest = crypto.createHash('sha256')
    .update(`${namespace}\0${resourceId}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function withGovernanceLock<T>(
  db: Knex,
  namespace: string,
  resourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKeys = governanceLockKeys(namespace, resourceId);
  const connection: any = await db.client.acquireConnection();
  try {
    await connection.query('SELECT pg_advisory_lock($1, $2)', lockKeys);
    return await operation();
  } finally {
    await connection.query('SELECT pg_advisory_unlock($1, $2)', lockKeys).catch(() => undefined);
    await db.client.releaseConnection(connection);
  }
}
