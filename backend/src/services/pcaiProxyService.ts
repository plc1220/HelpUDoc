import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getBackendEnv, type BackendEnv } from '../config/env';

/** Verifies the JWT forwarded by PCAI's oauth2-proxy; never trusts identity headers. */
export class PcaiProxyService {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly environment: () => BackendEnv = getBackendEnv) {
    const cfg = this.environment().pcaiSso;
    this.checkedUrl(cfg.issuerUrl, 'PCAI_SSO_ISSUER_URL');
    if (!cfg.audiences.length || cfg.audiences.some(value => !value.trim()) || !cfg.authorizedParty) {
      throw new Error('PCAI SSO requires expected audiences and an authorized party');
    }
    this.checkedUrl(cfg.portalUrl, 'PCAI_SSO_PORTAL_URL');
    this.checkedUrl(this.environment().frontendUrl, 'FRONTEND_URL');
    this.keys = createRemoteJWKSet(this.checkedUrl(cfg.jwksUrl, 'PCAI_SSO_JWKS_URL'), {
      timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    });
  }

  private checkedUrl(raw: string | undefined, name: string): URL {
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && this.environment().nodeEnv !== 'production')) {
      throw new Error(`${name} requires HTTPS`);
    }
    if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, query or fragment`);
    return url;
  }

  get applicationOrigin(): string { return new URL(this.environment().frontendUrl!).origin; }

  async verify(authorization: string) {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match || authorization.length > 16_384) throw new Error('Invalid PCAI bearer token');
    const cfg = this.environment().pcaiSso;
    const { payload } = await jwtVerify(match[1], this.keys, {
      issuer: cfg.issuerUrl, audience: cfg.audiences, algorithms: ['RS256'],
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'azp'], clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub !== payload.sub.trim()
      || payload.azp !== cfg.authorizedParty || typeof payload.iat !== 'number'
      || payload.iat > Date.now() / 1000 + 5) throw new Error('Invalid PCAI identity');
    // Only a verified email can claim an invitation or bootstrap ADMIN_EMAILS.
    const emailVerified = payload.email_verified === true;
    return {
      issuer: payload.iss!, subject: payload.sub,
      displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name
        : typeof payload.preferred_username === 'string' && payload.preferred_username.trim() ? payload.preferred_username : payload.sub,
      email: emailVerified && typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified,
    };
  }
}
