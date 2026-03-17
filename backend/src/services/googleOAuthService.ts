import crypto from 'crypto';
import { StoredOAuthToken, UserOAuthTokenService } from './userOAuthTokenService';

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

export type GoogleProfile = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export type DelegatedAccessToken = {
  accessToken: string;
  expiresAt: number;
  source: 'cached' | 'refreshed';
};

export class GoogleOAuthConfigError extends Error {}
export class GoogleOAuthTokenMissingError extends Error {}

function getRequiredEnv(key: string): string {
  const value = (process.env[key] || '').trim();
  if (!value) {
    throw new GoogleOAuthConfigError(`${key} is not configured`);
  }
  return value;
}

function getScopes(): string[] {
  const configured = (process.env.GOOGLE_OAUTH_SCOPES || '').trim();
  if (!configured) {
    return [...DEFAULT_SCOPES];
  }
  return configured
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function computeExpiryEpoch(expiresInSeconds?: number): number | undefined {
  if (!expiresInSeconds || expiresInSeconds <= 0) {
    return undefined;
  }
  return Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds);
}

function splitScopes(raw?: string): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

const SCOPE_EQUIVALENTS: Record<string, string[]> = {
  email: ['email', 'https://www.googleapis.com/auth/userinfo.email'],
  profile: ['profile', 'https://www.googleapis.com/auth/userinfo.profile'],
};

function hasRequiredScope(granted: Set<string>, required: string): boolean {
  const equivalents = SCOPE_EQUIVALENTS[required];
  if (!equivalents) {
    return granted.has(required);
  }
  return equivalents.some((scope) => granted.has(scope));
}

function getMissingScopes(grantedScope?: string): string[] {
  const granted = splitScopes(grantedScope);
  return getScopes().filter((scope) => !hasRequiredScope(granted, scope));
}

function ensureRequiredScopes(grantedScope?: string): void {
  const missingScopes = getMissingScopes(grantedScope);
  if (!missingScopes.length) {
    return;
  }
  throw new GoogleOAuthTokenMissingError(
    `Google account is missing required scopes. Please sign in with Google again to grant: ${missingScopes.join(', ')}`,
  );
}

export class GoogleOAuthService {
  constructor(private readonly tokenStore: UserOAuthTokenService) {}

  isConfigured(): boolean {
    return Boolean(
      (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
      && (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
      && (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim(),
    );
  }

  createPkceVerifier(): string {
    return crypto.randomBytes(48).toString('base64url');
  }

  createPkceChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  }

  createStateToken(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  getAuthStartUrl(params: { state: string; codeChallenge: string }): string {
    const clientId = getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID');
    const redirectUri = getRequiredEnv('GOOGLE_OAUTH_REDIRECT_URI');
    const url = new URL(GOOGLE_AUTH_BASE);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', getScopes().join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresIn?: number;
    scope?: string;
    tokenType?: string;
  }> {
    const clientId = getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = getRequiredEnv('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = getRequiredEnv('GOOGLE_OAUTH_REDIRECT_URI');

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    if (!accessToken) {
      throw new Error('Google token exchange returned no access token');
    }

    return {
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
      expiresIn: toNumber(data.expires_in),
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
    };
  }

  async verifyIdToken(idToken: string): Promise<void> {
    const clientId = getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID');
    const url = new URL(GOOGLE_TOKENINFO_ENDPOINT);
    url.searchParams.set('id_token', idToken);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google ID token verification failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const aud = typeof payload.aud === 'string' ? payload.aud : '';
    const exp = toNumber(payload.exp);

    if (aud !== clientId) {
      throw new Error('Google ID token audience mismatch');
    }

    if (!exp || exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Google ID token is expired');
    }
  }

  async fetchProfile(accessToken: string): Promise<GoogleProfile> {
    const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google userinfo fetch failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const sub = typeof data.sub === 'string' ? data.sub.trim() : '';
    if (!sub) {
      throw new Error('Google userinfo response missing sub');
    }

    return {
      sub,
      email: typeof data.email === 'string' ? data.email : undefined,
      name: typeof data.name === 'string' ? data.name : undefined,
      picture: typeof data.picture === 'string' ? data.picture : undefined,
    };
  }

  async upsertUserGoogleToken(
    userId: string,
    input: {
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
      scope?: string;
      tokenType?: string;
    },
  ): Promise<void> {
    const existing = await this.tokenStore.getToken(userId, 'google');
    const refreshToken = input.refreshToken || existing?.refreshToken;
    if (!refreshToken) {
      throw new Error('Google OAuth did not provide a refresh token; re-consent is required');
    }

    const token: StoredOAuthToken = {
      refreshToken,
      accessToken: input.accessToken,
      expiryDate: computeExpiryEpoch(input.expiresIn),
      scope: input.scope || existing?.scope,
      tokenType: input.tokenType || existing?.tokenType,
    };

    await this.tokenStore.upsertToken(userId, 'google', token);
  }

  async getDelegatedAccessToken(userId: string): Promise<DelegatedAccessToken> {
    const existing = await this.tokenStore.getToken(userId, 'google');
    if (!existing || !existing.refreshToken) {
      throw new GoogleOAuthTokenMissingError('Google account is not connected for this user');
    }

    ensureRequiredScopes(existing.scope);

    const now = Math.floor(Date.now() / 1000);
    if (existing.accessToken && existing.expiryDate && existing.expiryDate > now + 60) {
      return {
        accessToken: existing.accessToken,
        expiresAt: existing.expiryDate,
        source: 'cached',
      };
    }

    const clientId = getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = getRequiredEnv('GOOGLE_OAUTH_CLIENT_SECRET');

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: existing.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new GoogleOAuthTokenMissingError(
        `Failed to refresh Google access token (${response.status}): ${text.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    if (!accessToken) {
      throw new GoogleOAuthTokenMissingError('Google refresh response did not include access_token');
    }

    const expiresIn = toNumber(data.expires_in);
    const expiryDate = computeExpiryEpoch(expiresIn);
    const grantedScope = typeof data.scope === 'string' ? data.scope : existing.scope;
    ensureRequiredScopes(grantedScope);

    await this.tokenStore.upsertToken(userId, 'google', {
      refreshToken: existing.refreshToken,
      accessToken,
      expiryDate,
      scope: grantedScope,
      tokenType: typeof data.token_type === 'string' ? data.token_type : existing.tokenType,
    });

    return {
      accessToken,
      expiresAt: expiryDate || now + 300,
      source: 'refreshed',
    };
  }

  getPostLoginRedirectUrl(authError?: string): string {
    const base = (process.env.GOOGLE_OAUTH_POST_LOGIN_REDIRECT || process.env.FRONTEND_URL || 'http://localhost:5173').trim();
    const url = new URL(base);
    url.pathname = '/login';
    if (authError) {
      url.searchParams.set('authError', authError);
    }
    return url.toString();
  }
}
