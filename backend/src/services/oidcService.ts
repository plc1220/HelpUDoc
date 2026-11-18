import { createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { getBackendEnv, type BackendEnv } from '../config/env';

export type OidcTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  returnTo?: string;
};

export type OidcIdentity = {
  issuer: string;
  subject: string;
  displayName: string;
  email?: string;
  emailVerified: boolean;
  idToken: string;
};

export function safeReturnPath(raw?: string): string | undefined {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) return undefined;
  try {
    const base = 'https://return.invalid';
    const url = new URL(raw, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : undefined;
  } catch { return undefined; }
}

export function oidcExternalId(issuer: string, subject: string): string {
  // Keep case-sensitive issuer/sub semantics despite externalId normalization.
  return `oidc-${createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex')}`;
}

export const loginProvider = (): 'google' | 'oidc' | 'pcai-proxy' =>
  process.env.AUTH_PROVIDER === 'pcai-proxy' ? 'pcai-proxy' : process.env.AUTH_PROVIDER === 'oidc' ? 'oidc' : 'google';

export class OidcService {
  private configuration?: Promise<oidc.Configuration>;
  constructor(private readonly environment: () => BackendEnv = getBackendEnv) {}

  get displayName(): string { return this.environment().oidc.displayName; }

  isConfigured(): boolean {
    const cfg = this.environment().oidc;
    return Boolean(cfg.issuerUrl && cfg.clientId && cfg.clientSecret && cfg.redirectUri);
  }

  private checkedUrl(raw: string | undefined, name: string): URL {
    if (!raw) throw new Error(`${name} is not configured`);
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && this.environment().nodeEnv !== 'production')) {
      throw new Error(`${name} requires HTTPS`);
    }
    if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, query or fragment`);
    return url;
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.isConfigured()) throw new Error('OIDC is not configured');
    if (!this.configuration) {
      this.configuration = (async () => {
        const cfg = this.environment().oidc;
        const issuer = this.checkedUrl(cfg.issuerUrl, 'OIDC_ISSUER_URL');
        this.checkedUrl(cfg.redirectUri, 'OIDC_REDIRECT_URI');
        const execute = [oidc.enableNonRepudiationChecks];
        if (issuer.protocol === 'http:') execute.push(oidc.allowInsecureRequests);
        const configuration = await oidc.discovery(issuer, cfg.clientId!, {
          client_secret: cfg.clientSecret!,
          id_token_signed_response_alg: 'RS256',
        }, oidc.ClientSecretPost(cfg.clientSecret!), { execute, timeout: 10 });
        // The configured realm, not a value supplied by the browser, is authoritative.
        if (configuration.serverMetadata().issuer !== cfg.issuerUrl) throw new Error('OIDC issuer mismatch');
        for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
          this.checkedUrl(configuration.serverMetadata()[name], `OIDC ${name}`);
        }
        return configuration;
      })().catch((error) => { this.configuration = undefined; throw error; });
    }
    return this.configuration;
  }

  async begin(returnTo?: string): Promise<{ transaction: OidcTransaction; url: string }> {
    const configuration = await this.getConfiguration();
    const transaction: OidcTransaction = {
      state: oidc.randomState(), nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(), createdAt: Date.now(),
      returnTo: safeReturnPath(returnTo),
    };
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.environment().oidc.redirectUri!, response_type: 'code',
      scope: 'openid email profile', state: transaction.state, nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.codeVerifier),
      code_challenge_method: 'S256',
    });
    return { transaction, url: url.toString() };
  }

  async complete(callbackQuery: string, transaction: OidcTransaction): Promise<OidcIdentity> {
    const configuration = await this.getConfiguration();
    // Never construct the callback origin from Host or forwarded request headers.
    const callback = new URL(this.environment().oidc.redirectUri!);
    callback.search = callbackQuery;
    const tokens = await oidc.authorizationCodeGrant(configuration, callback, {
      expectedState: transaction.state, expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.codeVerifier, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub || !tokens.id_token) throw new Error('OIDC identity token is required');
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    return {
      issuer: claims.iss, subject: claims.sub, email,
      emailVerified: claims.email_verified === true,
      displayName: typeof claims.name === 'string' ? claims.name
        : typeof claims.preferred_username === 'string' ? claims.preferred_username : claims.sub,
      idToken: tokens.id_token,
    };
  }

  loginRedirect(error?: string, returnTo?: string): string {
    const env = this.environment();
    const frontend = this.checkedUrl(env.frontendUrl || new URL(env.oidc.redirectUri!).origin, 'FRONTEND_URL');
    const target = new URL('/login', frontend);
    if (error) target.searchParams.set('authError', error);
    const safe = safeReturnPath(returnTo);
    if (safe) target.searchParams.set('returnTo', safe);
    return target.toString();
  }

  async logoutUrl(idToken: string): Promise<string | undefined> {
    if (!this.environment().oidc.logoutFromProvider) return undefined;
    const configuration = await this.getConfiguration();
    const endpoint = configuration.serverMetadata().end_session_endpoint;
    if (!endpoint) return undefined;
    this.checkedUrl(endpoint, 'OIDC end_session_endpoint');
    const cfg = this.environment().oidc;
    const redirect = this.checkedUrl(cfg.postLogoutRedirectUri || this.loginRedirect(), 'OIDC_POST_LOGOUT_REDIRECT_URI');
    return oidc.buildEndSessionUrl(configuration, {
      client_id: cfg.clientId!, id_token_hint: idToken,
      post_logout_redirect_uri: redirect.toString(),
    }).toString();
  }
}
