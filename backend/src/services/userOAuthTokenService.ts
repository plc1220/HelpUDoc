import crypto from 'crypto';
import { Knex } from 'knex';
import { DatabaseService } from './databaseService';

export type OAuthProvider = 'google';

export type StoredOAuthToken = {
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number; // Unix epoch seconds
  scope?: string;
  tokenType?: string;
};

type EncryptedRecord = {
  v: number;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
};

const TOKEN_TABLE = 'user_oauth_tokens';

function toBase64Url(input: Buffer): string {
  return input.toString('base64url');
}

function fromBase64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function getEncryptionKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY is not configured');
  }
  const key = fromBase64Url(raw);
  if (key.length !== 32) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (base64url)');
  }
  return key;
}

function encryptJson(payload: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const record: EncryptedRecord = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    data: toBase64Url(ciphertext),
  };
  return JSON.stringify(record);
}

function decryptJson(encrypted: string): Record<string, unknown> {
  const key = getEncryptionKey();
  const parsed = JSON.parse(encrypted) as EncryptedRecord;
  if (!parsed || parsed.v !== 1 || parsed.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted token payload format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromBase64Url(parsed.iv));
  decipher.setAuthTag(fromBase64Url(parsed.tag));
  const decrypted = Buffer.concat([
    decipher.update(fromBase64Url(parsed.data)),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>;
}

function toStoredToken(raw: Record<string, unknown>): StoredOAuthToken {
  const refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken.trim() : '';
  if (!refreshToken) {
    throw new Error('Stored OAuth token is missing refreshToken');
  }

  return {
    refreshToken,
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : undefined,
    expiryDate: Number.isFinite(raw.expiryDate) ? Number(raw.expiryDate) : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    tokenType: typeof raw.tokenType === 'string' ? raw.tokenType : undefined,
  };
}

export class UserOAuthTokenService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async upsertToken(userId: string, provider: OAuthProvider, token: StoredOAuthToken): Promise<void> {
    const encryptedJson = encryptJson(token as unknown as Record<string, unknown>);

    await this.db(TOKEN_TABLE)
      .insert({
        userId,
        provider,
        encryptedJson,
      })
      .onConflict(['userId', 'provider'])
      .merge({
        encryptedJson,
        updatedAt: this.db.fn.now(),
      });
  }

  async getToken(userId: string, provider: OAuthProvider): Promise<StoredOAuthToken | null> {
    const row = await this.db(TOKEN_TABLE)
      .select('encryptedJson')
      .where({ userId, provider })
      .first();

    if (!row?.encryptedJson) {
      return null;
    }

    const decrypted = decryptJson(String(row.encryptedJson));
    return toStoredToken(decrypted);
  }

  async deleteToken(userId: string, provider: OAuthProvider): Promise<void> {
    await this.db(TOKEN_TABLE).where({ userId, provider }).del();
  }
}
