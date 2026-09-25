import crypto from 'crypto';

type JsonRecord = Record<string, unknown>;

const LOCAL_DEV_AGENT_JWT_SECRET = 'helpudoc-local-dev-agent-jwt-secret';

function getAgentJwtSecret(): string {
  const configured = process.env.AGENT_JWT_SECRET || '';
  if (configured.trim()) {
    return configured;
  }
  const env = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (!env || env === 'development') {
    return LOCAL_DEV_AGENT_JWT_SECRET;
  }
  return '';
}

const b64url = (input: Buffer | string): string => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  // Node supports base64url directly.
  return buf.toString('base64url');
};

export type AgentContextTokenPayload = {
  sub?: string;
  userId?: string;
  workspaceId?: string;
  skillAllowIds?: string[];
  skillVersionPins?: Record<string, {
    skillId: string;
    versionId: string;
    semanticVersion: string;
    manifestHash: string;
  }>;
  mcpServerAllowIds?: string[];
  mcpServerDenyIds?: string[];
  mcpAuth?: Record<string, Record<string, string>>;
  mcpAuthFingerprint?: string;
  isAdmin?: boolean;
  /**
   * Team Chat (F3) authenticated thread-history reader scope. Bound at sign time
   * to the run's workspace/user/thread and immutable cutoff so the agent tool can
   * only read that exact scope; the model cannot supply or widen it.
   */
  threadHistoryScope?: {
    workspaceId: string;
    userId: string;
    threadId: string;
    cutoffSeq: number;
    sourceMessageId?: string;
  };
  iat?: number;
  exp?: number;
} & JsonRecord;

export function signAgentContextToken(payload: AgentContextTokenPayload): string | null {
  const secret = getAgentJwtSecret();
  if (!secret) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: AgentContextTokenPayload = {
    iat: now,
    exp: now + 5 * 60, // 5 minutes
    ...payload,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const sigB64 = b64url(sig);
  return `${signingInput}.${sigB64}`;
}

/**
 * Verify an agent context token that the backend itself signed. Used by the
 * internal agent-callback endpoint so the Python agent can authenticate with the
 * same signed context it was issued (spec F3.4). This is a real Bearer-JWT
 * verification path, distinct from the browser/x-user-id userContext middleware
 * which does NOT verify agent tokens.
 *
 * Returns the decoded payload on a valid, unexpired HS256 signature, else null.
 */
export function verifyAgentContextToken(token: string): AgentContextTokenPayload | null {
  const secret = getAgentJwtSecret();
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  let payload: AgentContextTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}
