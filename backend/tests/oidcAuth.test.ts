import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import authRoutes from '../src/api/auth';
import { parseBackendEnv } from '../src/config/env';
import { OidcService, oidcExternalId, safeReturnPath } from '../src/services/oidcService';
import type { GoogleOAuthService } from '../src/services/googleOAuthService';
import type { UserService } from '../src/services/userService';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
type TokenOptions = { claims?: Record<string, unknown>; badSignature?: boolean; omitIdToken?: boolean };
const listen = async (app: express.Express) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const cookies = (response: Response, fallback = '') => response.headers.getSetCookie()
  .map(cookie => cookie.split(';')[0]).join('; ') || fallback;

async function fixture(options: { deactivated?: boolean; invited?: boolean; logout?: boolean; stale?: boolean } = {}) {
  const saved = { AUTH_PROVIDER: process.env.AUTH_PROVIDER, AUTH_MODE: process.env.AUTH_MODE, SIGNUP_MODE: process.env.SIGNUP_MODE };
  process.env.AUTH_PROVIDER = 'oidc'; process.env.AUTH_MODE = 'oidc';
  process.env.SIGNUP_MODE = options.invited === false ? 'invite_only' : 'open';
  let issuer = '', appOrigin = '', tokenRequests = 0;
  const pending = new Map<string, { nonce: string; challenge: string; options: TokenOptions }>();
  const profiles: Array<Record<string, unknown>> = [];
  const provider = express(); provider.use(express.urlencoded({ extended: false }));
  provider.get('/realms/site/.well-known/openid-configuration', (_req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs`,
    end_session_endpoint: `${issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  }));
  provider.get('/realms/site/certs', (_req, res) => res.json({ keys: [jwk] }));
  provider.post('/realms/site/token', (req, res) => {
    tokenRequests++;
    const entry = pending.get(req.body.code); pending.delete(req.body.code);
    if (!entry || req.body.client_id !== 'helpudoc' || req.body.client_secret !== 'fixture-client-secret'
      || req.body.redirect_uri !== `${appOrigin}/api/auth/oidc/callback`
      || createHash('sha256').update(req.body.code_verifier || '').digest('base64url') !== entry.challenge) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, sub: 'CaseSensitiveSubject', aud: 'helpudoc', iat: now, exp: now + 300,
      nonce: entry.nonce, name: 'PCAI User', email: 'member@example.com', email_verified: true, ...entry.options.claims };
    const input = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
    const signature = sign('RSA-SHA256', Buffer.from(input), entry.options.badSignature ? wrongKeys.privateKey : keys.privateKey).toString('base64url');
    return res.json({ access_token: 'private-provider-access-token', token_type: 'Bearer', expires_in: 300,
      ...(!entry.options.omitIdToken ? { id_token: `${input}.${signature}` } : {}) });
  });
  const providerHost = await listen(provider); issuer = `${providerHost.origin}/realms/site`;
  const env = () => parseBackendEnv({ NODE_ENV: 'test', FRONTEND_URL: appOrigin, OIDC_ISSUER_URL: issuer,
    OIDC_CLIENT_ID: 'helpudoc', OIDC_CLIENT_SECRET: 'fixture-client-secret', OIDC_DISPLAY_NAME: 'PCAI SSO',
    OIDC_REDIRECT_URI: `${appOrigin}/api/auth/oidc/callback`, OIDC_POST_LOGOUT_REDIRECT_URI: `${appOrigin}/login`,
    OIDC_LOGOUT_FROM_PROVIDER: options.logout === false ? 'false' : 'true' });
  const service = new OidcService(env);
  if (options.stale) {
    const begin = service.begin.bind(service);
    service.begin = async (...args) => { const result = await begin(...args); result.transaction.createdAt -= 600_001; return result; };
  }
  const users = {
    ensureUser: async (profile: Record<string, unknown>) => {
      profiles.push(profile);
      return { id: 'existing-member-id', externalId: profile.externalId, displayName: profile.displayName,
        email: profile.email, isAdmin: false, status: options.deactivated ? 'deactivated' : 'active', deactivatedAt: options.deactivated ? new Date() : null };
    },
    isAdmissibleSignIn: async () => options.invited !== false,
  } as unknown as UserService;
  const google = { isConfigured: () => false } as unknown as GoogleOAuthService;
  const app = express(); app.use(session({ secret: 'fixture-session-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.userContext = req.session.userContext; next(); });
  app.use('/api/auth', authRoutes(users, google, service));
  const appHost = await listen(app); appOrigin = appHost.origin;
  return {
    origin: appOrigin, issuer, profiles, service, tokenRequests: () => tokenRequests,
    start: async (returnTo = '/') => {
      const response = await fetch(`${appOrigin}/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const authorization = new URL(response.headers.get('location')!);
      const issue = (tokenOptions: TokenOptions = {}) => {
        const code = randomUUID();
        pending.set(code, { nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')!, options: tokenOptions });
        return `${appOrigin}/api/auth/oidc/callback?code=${code}&state=${authorization.searchParams.get('state')}`;
      };
      return { response, authorization, cookie: cookies(response), issue };
    },
    close: async () => {
      for (const host of [appHost, providerHost]) {
        host.server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => host.server.close(err => err ? reject(err) : resolve()));
      }
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}

test('OIDC discovery, signed code exchange, PKCE, session rotation and identity mapping work without Google', async () => {
  const f = await fixture();
  try {
    const flow = await f.start('/workspaces?selected=one');
    assert.equal(flow.authorization.origin, new URL(f.issuer).origin);
    assert.equal(flow.authorization.searchParams.get('scope'), 'openid email profile');
    assert.equal(flow.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(flow.authorization.searchParams.get('nonce'));
    const callback = await fetch(flow.issue(), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    assert.equal(callback.headers.get('location'), `${f.origin}/login?returnTo=%2Fworkspaces%3Fselected%3Done`);
    const authenticatedCookie = cookies(callback);
    assert.ok(authenticatedCookie && authenticatedCookie !== flow.cookie);
    const me = await fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: authenticatedCookie } });
    const data = await me.json() as any;
    assert.equal(data.authenticated, true); assert.equal(data.user.userId, 'existing-member-id');
    assert.equal(data.authProvider, 'oidc'); assert.equal(data.loginLabel, 'PCAI SSO');
    assert.equal(data.googleConfigured, false); assert.equal(data.loginConfigured, true);
    assert.equal(data.user.isAdmin, false); assert.ok(!JSON.stringify(data).includes('idToken'));
    assert.equal(f.profiles[0].oidcIssuer, f.issuer); assert.equal(f.profiles[0].oidcSubject, 'CaseSensitiveSubject');
    assert.equal(f.profiles[0].externalId, oidcExternalId(f.issuer, 'CaseSensitiveSubject'));
    const replay = await fetch(flow.issue(), { headers: { Cookie: authenticatedCookie }, redirect: 'manual' });
    assert.match(replay.headers.get('location')!, /oidc_session_expired/);
    assert.equal(f.tokenRequests(), 1);
  } finally { await f.close(); }
});

test('OIDC rejects wrong audience, issuer, nonce, expiry, signature and missing ID tokens', async () => {
  const f = await fixture();
  try {
    for (const options of [{ claims: { aud: 'another-client' } }, { claims: { iss: 'https://wrong.example/realm' } },
      { claims: { nonce: 'wrong-nonce' } }, { claims: { exp: 1 } }, { badSignature: true }, { omitIdToken: true }]) {
      const flow = await f.start();
      const response = await fetch(flow.issue(options), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
      assert.match(response.headers.get('location')!, /oidc_callback_failed/);
    }
    assert.equal(f.profiles.length, 0);
  } finally { await f.close(); }
});

test('OIDC requires server-side state and consumes it even when validation fails', async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    const codeUrl = flow.issue();
    const noSession = await fetch(codeUrl, { redirect: 'manual' });
    assert.match(noSession.headers.get('location')!, /oidc_session_expired/);
    const wrong = new URL(codeUrl); wrong.searchParams.set('state', 'untrusted');
    const mismatch = await fetch(wrong, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    assert.match(mismatch.headers.get('location')!, /oidc_state_mismatch/);
    const retry = await fetch(codeUrl, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    assert.match(retry.headers.get('location')!, /oidc_session_expired/);
    assert.equal(f.tokenRequests(), 0); assert.equal(f.profiles.length, 0);
  } finally { await f.close(); }
});

test('expired transactions, uninvited users and deactivated users receive no session', async () => {
  for (const options of [{ stale: true }, { invited: false }, { deactivated: true }]) {
    const f = await fixture(options);
    try {
      const flow = await f.start();
      const response = await fetch(flow.issue(), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
      assert.match(response.headers.get('location')!, options.stale ? /oidc_state_mismatch/ : options.invited === false ? /not_invited/ : /account_deactivated/);
      const me = await fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: flow.cookie } });
      assert.equal((await me.json() as any).authenticated, false);
      if (options.invited === false) assert.equal(f.profiles.length, 0);
    } finally { await f.close(); }
  }
});

test('unverified email is excluded from invitation and admin-email matching', async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    await fetch(flow.issue({ claims: { email: 'admin@example.com', email_verified: false } }), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    assert.equal(f.profiles[0].email, undefined); assert.equal(f.profiles[0].emailVerified, false);
  } finally { await f.close(); }
});

test('OIDC logout destroys the application session and returns the realm logout URL', async () => {
  for (const providerLogout of [true, false]) {
    const f = await fixture({ logout: providerLogout });
    try {
      const flow = await f.start();
      const callback = await fetch(flow.issue(), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
      const cookie = cookies(callback);
      const forbidden = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example' } });
      assert.equal(forbidden.status, 403);
      const result = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: f.origin } });
      const data = await result.json() as any; assert.equal(data.success, true);
      if (providerLogout) {
        const target = new URL(data.redirectUrl);
        assert.equal(target.origin + target.pathname, `${f.issuer}/logout`);
        assert.equal(target.searchParams.get('post_logout_redirect_uri'), `${f.origin}/login`);
        assert.equal(target.searchParams.get('client_id'), 'helpudoc');
        assert.ok(target.searchParams.get('id_token_hint'));
      } else assert.equal(data.redirectUrl, undefined);
      const me = await fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: cookie } });
      assert.equal((await me.json() as any).authenticated, false);
    } finally { await f.close(); }
  }
});

test('return paths reject external redirects and subjects remain case-sensitive', () => {
  for (const path of ['https://evil.example', '//evil.example', '/\\evil.example', '/\nevil.example']) assert.equal(safeReturnPath(path), undefined);
  assert.equal(safeReturnPath('/workspaces?q=one#file'), '/workspaces?q=one#file');
  assert.notEqual(oidcExternalId('https://realm', 'SUBJECT'), oidcExternalId('https://realm', 'subject'));
  assert.notEqual(oidcExternalId('https://realm-one', 'subject'), oidcExternalId('https://realm-two', 'subject'));
});

test('production OIDC never permits plaintext discovery or callback endpoints', async () => {
  const service = new OidcService(() => parseBackendEnv({ NODE_ENV: 'production', OIDC_ISSUER_URL: 'http://127.0.0.1/realm',
    OIDC_CLIENT_ID: 'helpudoc', OIDC_CLIENT_SECRET: 'secret', OIDC_REDIRECT_URI: 'https://app.example/callback' }));
  await assert.rejects(service.begin(), /HTTPS/);
  const callbackService = new OidcService(() => parseBackendEnv({ NODE_ENV: 'production', OIDC_ISSUER_URL: 'https://realm.example/realm',
    OIDC_CLIENT_ID: 'helpudoc', OIDC_CLIENT_SECRET: 'secret', OIDC_REDIRECT_URI: 'http://127.0.0.1/callback' }));
  await assert.rejects(callbackService.begin(), /HTTPS/);
});

test('Keycloak users can explicitly connect Google services without changing their app identity', async () => {
  const previous = process.env.AUTH_PROVIDER; process.env.AUTH_PROVIDER = 'oidc';
  const stored: unknown[][] = [];
  const owner = { userId: 'keycloak-user', externalId: oidcExternalId('https://realm.example', 'subject'), displayName: 'PCAI User', isAdmin: false };
  const google = {
    isConfigured: () => true, createPkceVerifier: () => 'verifier', createPkceChallenge: () => 'challenge', createStateToken: () => 'state',
    getAuthStartUrl: () => 'https://accounts.google.com/consent',
    exchangeCodeForTokens: async () => ({ accessToken: 'service-grant' }),
    fetchProfile: async () => ({ sub: 'google-service-account', email: 'secondary@example.com' }),
    upsertUserGoogleToken: async (...input: unknown[]) => { stored.push(input); },
    getPostLoginRedirectUrl: (error?: string) => `http://frontend.local/login${error ? `?authError=${error}` : ''}`,
  } as unknown as GoogleOAuthService;
  const users = { ensureUser: () => { throw new Error('Service grants must not replace Keycloak login'); } } as unknown as UserService;
  const app = express(); app.use(session({ secret: 'service-grant-session', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.userContext = owner; req.session.userContext = owner; next(); });
  app.use('/auth', authRoutes(users, google));
  const host = await listen(app);
  try {
    const start = await fetch(`${host.origin}/auth/google/start?extraScopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const callback = await fetch(`${host.origin}/auth/google/callback?state=state&code=one-use`, { headers: { Cookie: cookies(start) }, redirect: 'manual' });
    assert.equal(callback.headers.get('location'), 'http://frontend.local/login');
    assert.equal(stored.length, 1); assert.equal(stored[0][0], owner.userId);
    const forbidden = await fetch(`${host.origin}/auth/google/start`, { redirect: 'manual' });
    assert.equal(forbidden.status, 400);
  } finally {
    host.server.closeIdleConnections();
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    if (previous === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = previous;
  }
});
