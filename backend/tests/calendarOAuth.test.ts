import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import authRoutes from '../src/api/auth';
import { GoogleOAuthService } from '../src/services/googleOAuthService';
import type { UserOAuthTokenService } from '../src/services/userOAuthTokenService';
import type { UserService } from '../src/services/userService';
import { loggingMiddleware } from '../src/api/logging';

const owner = { userId: '11111111-1111-4111-8111-111111111111', externalId: 'fixture', displayName: 'Fixture', isAdmin: false };
test('basic identity login preserves Google service grants and rejects service scope upgrades', async () => {
  const starts: Array<Record<string, unknown>> = [];
  const oauth = {
    isConfigured: () => true, createPkceVerifier: () => 'verifier', createPkceChallenge: () => 'challenge', createStateToken: () => 'state',
    getAuthStartUrl: (input: Record<string, unknown>) => { starts.push(input); return 'https://accounts.google.com/test'; },
    exchangeCodeForTokens: async () => ({ accessToken: 'identity-token' }),
    fetchProfile: async () => ({ sub: 'google-identity', email: 'fixture@example.com' }),
    upsertUserGoogleToken: async () => { throw new Error('Identity sign-in cannot replace service grants'); },
    getPostLoginRedirectUrl: (error?: string) => `http://frontend.local/login${error ? `?authError=${error}` : ''}`,
  } as unknown as GoogleOAuthService;
  const users = { ensureUser: async () => ({ id: owner.userId, externalId: owner.externalId }) } as unknown as UserService;
  const app = express(); app.use(session({ secret: 'identity-test-secret', resave: false, saveUninitialized: false })); app.use('/auth', authRoutes(users, oauth));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const start = await fetch(`${base}/auth/google/start?identityOnly=true`, { redirect: 'manual' });
    assert.equal(start.status, 302); assert.equal(starts[0].identityOnly, true);
    const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const result = await fetch(`${base}/auth/google/callback?state=state&code=one-use-code`, { headers: { Cookie: cookies }, redirect: 'manual' });
    assert.equal(result.headers.get('Location'), 'http://frontend.local/login');
    assert.equal((await fetch(`${base}/auth/google/start?identityOnly=true&calendar=true`, { redirect: 'manual' })).status, 400);
    const cookieOnly = cookies.split('; ').filter(value => !value.startsWith('connect.sid=')).join('; ');
    const expired = await fetch(`${base}/auth/google/callback?state=state&code=one-use-code`, { headers: { Cookie: cookieOnly }, redirect: 'manual' });
    assert.match(expired.headers.get('Location') || '', /identity_session_expired/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('dedicated Calendar and identity consent excludes unrelated prior Google scopes', () => {
  const saved = [process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_REDIRECT_URI];
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'fixture-client'; process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost/callback';
  try {
    const oauth = new GoogleOAuthService({} as UserOAuthTokenService);
    const calendar = new URL(oauth.getAuthStartUrl({ state: 'state', codeChallenge: 'challenge', calendarOnly: true, extraScopes: ['https://www.googleapis.com/auth/calendar.events'] }));
    assert.equal(calendar.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(calendar.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/calendar.events');
    const identity = new URL(oauth.getAuthStartUrl({ state: 'state', codeChallenge: 'challenge', identityOnly: true }));
    assert.equal(identity.searchParams.get('include_granted_scopes'), 'false'); assert.equal(identity.searchParams.get('scope'), 'openid email profile');
  } finally {
    for (const [i, key] of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_REDIRECT_URI'].entries()) { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }
  }
});

test('Calendar callback binds secondary Google accounts to the existing user without replacing login or agent grant', async () => {
  const stored: unknown[][] = [], starts: Array<Record<string, unknown>> = [];
  const oauth = {
    isConfigured: () => true, createPkceVerifier: () => 'verifier', createPkceChallenge: () => 'challenge', createStateToken: () => 'state',
    getAuthStartUrl: (input: Record<string, unknown>) => { starts.push(input); return 'https://accounts.google.com/test'; },
    exchangeCodeForTokens: async () => ({ accessToken: 'short-lived-token', refreshToken: 'refresh-token' }),
    fetchProfile: async () => ({ sub: 'secondary-google-identity', email: 'secondary@example.com' }),
    upsertUserGoogleToken: async (...input: unknown[]) => { stored.push(input); },
    getPostLoginRedirectUrl: (error?: string) => `http://frontend.local/login${error ? `?authError=${error}` : ''}`,
  } as unknown as GoogleOAuthService;
  const users = { ensureUser: () => { throw new Error('Calendar consent must not replace login'); } } as unknown as UserService;
  const app = express(); app.use(session({ secret: 'calendar-test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.userContext = owner; next(); }); app.use('/auth', authRoutes(users, oauth));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const start = await fetch(`${base}/auth/google/start?calendar=true&returnTo=%2F%3Fcalendar%3Dopen`, { redirect: 'manual' });
    assert.equal(start.status, 302); assert.equal(starts[0].calendarOnly, true);
    assert.deepEqual(starts[0].extraScopes, ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']);
    const cookies = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const result = await fetch(`${base}/auth/google/callback?state=state&code=one-use-code`, { headers: { Cookie: cookies }, redirect: 'manual' });
    assert.equal(result.status, 302); assert.equal(result.headers.get('Location'), 'http://frontend.local/?calendar=open');
    assert.equal(stored.length, 1); assert.equal(stored[0][0], owner.userId); assert.match(String(stored[0][2]), /^calendar:[a-f0-9]{32}$/);
    const badUpgrade = await fetch(`${base}/auth/google/start?extraScopes=${encodeURIComponent('https://www.googleapis.com/auth/calendar.events')}`, { redirect: 'manual' });
    assert.equal(badUpgrade.status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('Calendar-only delegated token retrieval does not require unrelated Gmail or BigQuery scopes', async () => {
  const calls: string[] = [];
  const store = { getToken: async (_user: string, provider: string) => { calls.push(provider); return { refreshToken: 'never-return-this', accessToken: 'short-lived', expiryDate: Math.floor(Date.now() / 1000) + 3600, scope: 'https://www.googleapis.com/auth/calendar.events' }; } } as unknown as UserOAuthTokenService;
  const oauth = new GoogleOAuthService(store);
  const token = await oauth.getDelegatedAccessToken(owner.userId, ['https://www.googleapis.com/auth/calendar.events'], true, 'calendar:account');
  assert.equal(token.accessToken, 'short-lived'); assert.deepEqual(calls, ['calendar:account']); assert.equal('refreshToken' in token, false);
});
test('request logs omit OAuth codes, state, tokens and source bodies', () => {
  const output: unknown[] = [], log = console.log; console.log = value => { output.push(value); };
  try { loggingMiddleware({ method: 'GET', originalUrl: '/api/auth/google/callback?code=secret-code&state=secret-state', body: { token: 'private-token' } } as never, {} as never, () => undefined); }
  finally { console.log = log; }
  const text = JSON.stringify(output); assert.ok(!text.includes('secret-code')); assert.ok(!text.includes('secret-state')); assert.ok(!text.includes('private-token'));
});

test('signed Calendar reader permits only the selected event and rechecks current workspace access', async () => {
  const { default: internalRoutes } = await import('../src/api/internalAgent');
  const { signAgentContextToken } = await import('../src/services/agentToken');
  const { HttpError } = await import('../src/errors');
  let allowed = true, reads = 0;
  const calendar = { event: async (_user: string, ref: string) => { reads++; return { id: ref }; }, links: async () => ({ confirmed: [] }) };
  const app = express(); app.use('/internal', internalRoutes({} as never, calendar as never, { isDeactivated: async () => false } as never, { ensureMembership: async () => { if (!allowed) throw new HttpError(403, 'Workspace access revoked'); } } as never));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/calendar/events/`;
  const token = (refs?: string[]) => signAgentContextToken({ userId: owner.userId, workspaceId: 'workspace', calendarEventRefs: refs })!;
  try {
    assert.equal((await fetch(`${base}meeting:one`, { headers: { Authorization: `Bearer ${token()}` } })).status, 403);
    assert.equal((await fetch(`${base}meeting:other`, { headers: { Authorization: `Bearer ${token(['meeting:one'])}` } })).status, 403);
    assert.equal(reads, 0);
    const valid = await fetch(`${base}meeting:one`, { headers: { Authorization: `Bearer ${token(['meeting:one'])}` } });
    assert.equal(valid.status, 200); assert.equal((await valid.json() as { content_is_untrusted: boolean }).content_is_untrusted, true);
    allowed = false;
    assert.equal((await fetch(`${base}meeting:one`, { headers: { Authorization: `Bearer ${token(['meeting:one'])}` } })).status, 403);
    assert.equal(reads, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
