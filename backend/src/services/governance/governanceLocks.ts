import crypto from 'crypto';
import type { Knex } from 'knex';

export async function withGovernanceLock<T>(
  db: Knex,
  namespace: string,
  resourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const digest = crypto.createHash('sha256')
    .update(`${namespace}\0${resourceId}`)
    .digest();
  const lockKeys = [digest.readInt32BE(0), digest.readInt32BE(4)];
  const connection: any = await db.client.acquireConnection();
  try {
    await connection.query('SELECT pg_advisory_lock($1, $2)', lockKeys);
    return await operation();
  } finally {
    await connection.query('SELECT pg_advisory_unlock($1, $2)', lockKeys).catch(() => undefined);
    await db.client.releaseConnection(connection);
  }
}
