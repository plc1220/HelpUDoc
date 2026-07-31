import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  JsonRecord,
  SkillGovernanceError,
  jsonValue,
  stateHash,
} from './skillGovernanceModel';

type StoredError = {
  error: string;
  code: string;
  details?: unknown;
};

export class GovernanceIdempotency {
  constructor(private readonly db: Knex) {}

  async run<T extends JsonRecord>(
    userId: string,
    action: string,
    key: string | undefined,
    requestBody: unknown,
    operation: () => Promise<T>,
  ): Promise<{ body: T; replayed: boolean }> {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return { body: await operation(), replayed: false };
    if (normalizedKey.length > 255) {
      throw new SkillGovernanceError(400, 'INVALID_SKILL_MANIFEST', 'Idempotency-Key is too long');
    }

    const requestHash = stateHash(requestBody);
    const digest = crypto.createHash('sha256')
      .update(`${userId}\0${action}\0${normalizedKey}`)
      .digest();
    const lockKeys = [digest.readInt32BE(0), digest.readInt32BE(4)];
    const connection: any = await this.db.client.acquireConnection();
    try {
      await connection.query('SELECT pg_advisory_lock($1, $2)', lockKeys);
      const existing = await this.findCurrent(userId, action, normalizedKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new SkillGovernanceError(
            409,
            'SKILL_REVISION_CONFLICT',
            'Idempotency-Key was already used with a different request',
          );
        }
        if (Number(existing.responseStatus) >= 400) {
          const stored = jsonValue<StoredError>(existing.responseBody, {
            error: 'Governance request failed',
            code: 'GOVERNANCE_INTERNAL_ERROR',
          });
          throw new SkillGovernanceError(
            Number(existing.responseStatus),
            stored.code,
            stored.error,
            stored.details,
          );
        }
        return { body: jsonValue<T>(existing.responseBody, {} as T), replayed: true };
      }

      try {
        const body = await operation();
        await this.persist(userId, action, normalizedKey, requestHash, 200, body);
        return { body, replayed: false };
      } catch (error) {
        if (error instanceof SkillGovernanceError && error.committed) {
          await this.persist(userId, action, normalizedKey, requestHash, error.statusCode, {
            error: error.message,
            code: error.code,
            details: error.details,
          });
        }
        throw error;
      }
    } finally {
      await connection.query('SELECT pg_advisory_unlock($1, $2)', lockKeys).catch(() => undefined);
      await this.db.client.releaseConnection(connection);
    }
  }

  private async findCurrent(userId: string, action: string, key: string): Promise<any | null> {
    const identity = { actorUserId: userId, action, idempotencyKey: key };
    const existing = await this.db('idempotency_records').where(identity).first();
    if (!existing) return null;
    if (new Date(existing.expiresAt).getTime() > Date.now()) return existing;
    await this.db('idempotency_records').where(identity).del();
    return null;
  }

  private async persist(
    userId: string,
    action: string,
    key: string,
    requestHash: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    await this.db('idempotency_records').insert({
      actorUserId: userId,
      action,
      idempotencyKey: key,
      requestHash,
      responseBody: JSON.stringify(responseBody),
      responseStatus,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }
}
