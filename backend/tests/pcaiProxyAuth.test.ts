import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import { parseBackendEnv, resetBackendEnvCacheForTests } from '../src/config/env';
import authRoutes from '../src/api/auth';
import internalAgentRoutes from '../src/api/internalAgent';
import { userContextMiddleware } from '../src/middleware/userContext';
import { PcaiProxyService } from '../src/services/pcaiProxyService';
import { oidcExternalId } from '../src/services/oidcService';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'pcai-key', use: 'sig' };
const cookieOf = (res: Response, fallback = '') => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') || fallback;

async function fixture(options: { invited?: boolean; deactivated?: boolean; jwksDown?: boolean } = {}) {
  const saved = { ...process.env };
  let jwksRequests = 0;
  const profiles: any[] = [];
  const provider = express();
  provider.get('/realms/UA/protocol/openid-connect/certs', (_req, res) => {
    jwksRequests++;
    return options.jwksDown ? res.sendStatus(503) : res.json({ keys: [jwk] });
  });
  const listen = async (app: express.Express) => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const keyHost = await listen(provider);
  const issuer = `${keyHost.origin}/realms/UA`;
  Object.assign(process.env, {
    NODE_ENV: 'test', AUTH_MODE: 'oidc', AUTH_PROVIDER: 'pcai-proxy',
    PCAI_SSO_ISSUER_URL: issuer, PCAI_SSO_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
    PCAI_SSO_AUDIENCES: 'ua', PCAI_SSO_AUTHORIZED_PARTY: 'ua', PCAI_SSO_PORTAL_URL: 'https://pcai.example.com/home',
    PCAI_SSO_DISPLAY_NAME: 'PCAI', FRONTEND_URL: 'https://lumo.example.com',
    SIGNUP_MODE: options.invited === false ? 'invite_only' : 'open',
  });
  resetBackendEnvCacheForTests();
  const users = {
    ensureUser: async (profile: any) => {
      profiles.push(profile);
      return { id: profile.externalId, ...profile, isAdmin: false,
        status: options.deactivated ? 'deactivated' : 'active', deactivatedAt: options.deactivated ? new Date() : null };
    },
    isAdmissibleSignIn: async () => options.invited !== false,
  };
  const app = express();
  app.use(session({ secret: 'proxy-fixture-session-secret', resave: false, saveUninitialized: false }));
  app.get('/fixture/old-session', (req, res) => {
    req.session.externalId = oidcExternalId(issuer, 'CaseSensitiveSubject');
    req.session.oidcLogin = { idToken: 'old-id-token' };
    res.json({ success: true });
  });
  app.use(userContextMiddleware(users as any));
  const google = { isConfigured: () => true } as any;
  app.use('/api/auth', authRoutes(users as any, google));
  app.use('/api/internal/agent', internalAgentRoutes({} as any));
  app.get('/api/private', (req, res) => res.json({ user: req.userContext,
    sessionKeys: Object.keys(req.session), sid: req.sessionID }));
  const appHost = await listen(app);
  return {
    origin: appHost.origin, profiles, issuer, jwksRequests: () => jwksRequests,
    token: (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, wrongKey = false) => {
      const now = Math.floor(Date.now() / 1000);
      const input = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'pcai-key', ...header })).toString('base64url'),
        Buffer.from(JSON.stringify({ iss: issuer, sub: 'CaseSensitiveSubject', aud: 'ua', azp: 'ua',
          iat: now, exp: now + 300, name: 'PCAI Member', email: 'member@example.com', email_verified: true, ...claims })).toString('base64url')].join('.');
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), wrongKey ? otherKeys.privateKey : keys.privateKey).toString('base64url')}`;
    },
    close: async () => {
      for (const host of [keyHost, appHost]) {
        host.server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => host.server.close(err => err ? reject(err) : resolve()));
      }
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); resetBackendEnvCacheForTests();
    },
  };
}

test('PCAI JWT automatically authenticates /me without an app OAuth client; header claims and realm admin roles are ignored', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.origin}/api/auth/me`, { headers: {
      Authorization: `Bearer ${f.token({ groups: ['admin'] })}`, 'X-User-Id': 'attacker',
      'X-Auth-Request-Email': 'attacker@example.com',
    } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.authenticated, true);
    assert.equal(body.authProvider, 'pcai-proxy');
    assert.equal(body.loginConfigured, true);
    assert.equal(body.user.email, 'member@example.com');
    assert.equal(body.user.isAdmin, false);
    assert.equal(body.user.externalId, oidcExternalId(f.issuer, 'CaseSensitiveSubject'));
    const privateResponse = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token()}`, Cookie: cookieOf(response) } });
    const privateBody = await privateResponse.json() as any;
    assert.equal(privateResponse.status, 200);
    assert.equal(f.jwksRequests(), 1, 'JWKS is cached, tokens are verified on every request');
    assert.equal(privateBody.sessionKeys.some((key: string) => /token|oidcLogin/i.test(key)), false);
    const oldSession = await fetch(`${f.origin}/fixture/old-session`);
    const migrated = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token()}`, Cookie: cookieOf(oldSession) } });
    assert.equal((await migrated.json() as any).sessionKeys.includes('oidcLogin'), false);
    const oidcStart = await fetch(`${f.origin}/api/auth/oidc/start`, { redirect: 'manual', headers: { Authorization: `Bearer ${f.token()}` } });
    assert.equal(oidcStart.status, 404);
    const googleStart = await fetch(`${f.origin}/api/auth/google/start`, { redirect: 'manual', headers: { Authorization: `Bearer ${f.token()}` } });
    assert.equal(googleStart.status, 400);
  } finally { await f.close(); }
});

test('missing tokens and spoofed identity headers cannot use a previously valid Lumo session', async () => {
  const f = await fixture();
  try {
    const signed = await fetch(`${f.origin}/api/auth/me`, { headers: { Authorization: `Bearer ${f.token()}` } });
    const cookie = cookieOf(signed);
    const rejected = await fetch(`${f.origin}/api/private`, { headers: { Cookie: cookie, 'X-User-Id': 'attacker', 'X-Auth-Request-Email': 'member@example.com' } });
    assert.equal(rejected.status, 401);
    const me = await fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: cookie } });
    const body = await me.json() as any;
    assert.equal(body.authenticated, false);
    assert.equal(body.loginErrorCode, 'pcai_token_missing');
    assert.equal(body.authProvider, 'pcai-proxy');
    assert.equal(f.profiles.length, 1);
  } finally { await f.close(); }
});

test('signature, issuer, audience, expiry, not-before, azp, subject and signing algorithm are enforced', async t => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const [name, claims, header, wrongKey] of [
      ['signature', {}, {}, true], ['issuer', { iss: 'https://wrong.example.com/realms/UA' }],
      ['audience', { aud: 'another-client' }], ['missing audience', { aud: undefined }],
      ['expiry', { exp: now - 60 }], ['missing expiry', { exp: undefined }],
      ['not before', { nbf: now + 60 }], ['issued in future', { iat: now + 60 }],
      ['authorized party', { azp: 'another-client' }], ['missing azp', { azp: undefined }],
      ['empty subject', { sub: '' }], ['missing subject', { sub: undefined }],
      ['algorithm', {}, { alg: 'HS256' }], ['unknown key', {}, { kid: 'unknown' }],
    ] as Array<[string, Record<string, unknown>, Record<string, unknown>?, boolean?]>) {
      await t.test(name, async () => {
        const res = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token(claims, header, wrongKey)}` } });
        assert.equal(res.status, 401);
        assert.equal((await res.json() as any).code, 'pcai_token_invalid');
      });
    }
    assert.equal(f.profiles.length, 0);
  } finally { await f.close(); }
});

test('proxy identity changes rotate the session and retain the issuer/subject identity used by direct OIDC', async () => {
  const f = await fixture();
  try {
    const first = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token()}` } });
    const cookie = cookieOf(first), firstBody = await first.json() as any;
    const next = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token({ sub: 'OtherSubject', email: 'other@example.com' })}`, Cookie: cookie } });
    const nextBody = await next.json() as any;
    assert.equal(next.status, 200);
    assert.notEqual(nextBody.sid, firstBody.sid);
    assert.notEqual(nextBody.user.userId, firstBody.user.userId);
    assert.equal(nextBody.user.externalId, oidcExternalId(f.issuer, 'OtherSubject'));
    const invalid = await fetch(`${f.origin}/api/private`, { headers: { Cookie: cookieOf(next), Authorization: `Bearer ${f.token({}, {}, true)}` } });
    assert.equal(invalid.status, 401);
  } finally { await f.close(); }
});

test('unverified email cannot claim an invitation or ADMIN_EMAILS; local app role comes from the database', async () => {
  const f = await fixture();
  try {
    process.env.ADMIN_EMAILS = 'member@example.com';
    const res = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token({ email_verified: false })}` } });
    assert.equal(res.status, 200);
    assert.equal(f.profiles[0].email, undefined);
    assert.equal(f.profiles[0].emailVerified, false);
  } finally { await f.close(); }
});

test('invite-only and deactivated accounts remain blocked with useful /me metadata', async t => {
  for (const [code, options] of [['not_invited', { invited: false }], ['account_deactivated', { deactivated: true }]] as const) {
    await t.test(code, async () => {
      const f = await fixture(options);
      try {
        if (options.invited === false) process.env.SIGNUP_MODE = ' INVITE_ONLY ';
        const headers = { Authorization: `Bearer ${f.token()}` };
        assert.equal((await fetch(`${f.origin}/api/private`, { headers })).status, 403);
        const me = await fetch(`${f.origin}/api/auth/me`, { headers });
        const body = await me.json() as any;
        assert.equal(body.authenticated, false);
        assert.equal(body.loginErrorCode, code);
        if (options.invited === false) assert.equal(f.profiles.length, 0);
      } finally { await f.close(); }
    });
  }
});

test('JWKS outages fail closed and internal callbacks retain their separate agent-token checks', async () => {
  const f = await fixture({ jwksDown: true });
  try {
    const res = await fetch(`${f.origin}/api/private`, { headers: { Authorization: `Bearer ${f.token()}` } });
    assert.equal(res.status, 401);
    const callback = await fetch(`${f.origin}/api/internal/agent/team-chat/thread-history`, { headers: { Authorization: 'Bearer not-an-agent-token' } });
    assert.equal(callback.status, 401);
    assert.match((await callback.json() as any).error, /agent context token/);
    assert.equal(f.jwksRequests(), 1);
    assert.equal(f.profiles.length, 0);
  } finally { await f.close(); }
});

test('another origin cannot use the shared PCAI cookie to access Lumo, even with a valid forwarded token', async () => {
  const f = await fixture();
  try {
    for (const method of ['GET', 'POST']) {
      const res = await fetch(`${f.origin}/api/private`, { method, headers: {
        Authorization: `Bearer ${f.token()}`, Origin: 'https://another-app.example.com',
      } });
      assert.equal(res.status, 403);
      assert.equal((await res.json() as any).code, 'origin_not_allowed');
    }
    const sameOrigin = await fetch(`${f.origin}/api/private`, { headers: {
      Authorization: `Bearer ${f.token()}`, Origin: 'https://lumo.example.com',
    } });
    assert.equal(sameOrigin.status, 200);
  } finally { await f.close(); }
});

test('returning to PCAI clears the Lumo session, checks Origin and does not sign out the shared provider', async () => {
  const f = await fixture();
  try {
    const signed = await fetch(`${f.origin}/api/auth/me`, { headers: { Authorization: `Bearer ${f.token()}` } });
    const cookie = cookieOf(signed);
    const wrong = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example.com' } });
    assert.equal(wrong.status, 403);
    const result = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://lumo.example.com' } });
    assert.equal(result.status, 200);
    assert.equal((await result.json() as any).redirectUrl, 'https://pcai.example.com/home');
    assert.match(result.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  } finally { await f.close(); }
});

test('production proxy configuration requires HTTPS issuer, JWKS, portal and an explicit audience/azp', () => {
  const valid = { NODE_ENV: 'production', FRONTEND_URL: 'https://lumo.example.com',
    PCAI_SSO_ISSUER_URL: 'https://keycloak.example.com/realms/UA',
    PCAI_SSO_JWKS_URL: 'https://keycloak.example.com/realms/UA/protocol/openid-connect/certs',
    PCAI_SSO_AUDIENCES: 'ua', PCAI_SSO_AUTHORIZED_PARTY: 'ua', PCAI_SSO_PORTAL_URL: 'https://pcai.example.com/home' };
  assert.doesNotThrow(() => new PcaiProxyService(() => parseBackendEnv(valid)));
  for (const override of [
    { PCAI_SSO_ISSUER_URL: 'http://localhost/realms/UA' }, { PCAI_SSO_JWKS_URL: 'http://keycloak/certs' },
    { PCAI_SSO_JWKS_URL: 'https://user:password@keycloak.example.com/certs' },
    { PCAI_SSO_PORTAL_URL: 'https://pcai.example.com/home?redirect=elsewhere' },
    { PCAI_SSO_AUDIENCES: '' }, { PCAI_SSO_AUTHORIZED_PARTY: '' },
  ]) assert.throws(() => new PcaiProxyService(() => parseBackendEnv({ ...valid, ...override })));
});
