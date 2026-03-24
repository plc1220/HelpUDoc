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
  mcpServerAllowIds?: string[];
  mcpServerDenyIds?: string[];
  mcpAuth?: Record<string, Record<string, string>>;
  mcpAuthFingerprint?: string;
  isAdmin?: boolean;
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
