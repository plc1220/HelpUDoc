import crypto from 'crypto';

type JsonRecord = Record<string, unknown>;

const b64url = (input: Buffer | string): string => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  // Node supports base64url directly.
  return buf.toString('base64url');
};

export type AgentContextTokenPayload = {
  sub?: string;
  userId?: string;
  workspaceId?: string;
  mcpServerAllowIds?: string[];
  mcpServerDenyIds?: string[];
  isAdmin?: boolean;
  iat?: number;
  exp?: number;
} & JsonRecord;

export function signAgentContextToken(payload: AgentContextTokenPayload): string | null {
  const secret = process.env.AGENT_JWT_SECRET || '';
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

