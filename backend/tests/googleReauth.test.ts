import assert from 'node:assert/strict';
import test from 'node:test';

// `policy.ts` reads AUTH_MODE when it loads, and the delegated Google branch runs
// only outside header auth. Each test file runs in its own process.
process.env.AUTH_MODE = 'oidc';

import {
  GoogleOAuthService,
  GoogleOAuthTokenMissingError,
  classifyGoogleRefreshFailure,
} from '../src/services/googleOAuthService';
import { HttpError } from '../src/errors';
import { resetBackendEnvCacheForTests } from '../src/config/env';

const OAUTH_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/api/auth/google/callback',
  // Match the stored grant, so the scope check passes and the refresh runs.
  GOOGLE_OAUTH_SCOPES: 'openid email profile',
};

const withEnv = (t: { after: (fn: () => void) => void }, values: Record<string, string>) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  resetBackendEnvCacheForTests();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetBackendEnvCacheForTests();
  });
};

/** A stored grant whose access token has expired, so the next call must refresh. */
const expiredTokenStore = () => {
  const deleted: Array<{ userId: string; refreshToken: string }> = [];
  return {
    deleted,
    store: {
      getToken: async () => ({
        refreshToken: 'refresh-token-1',
        accessToken: 'stale',
        expiryDate: Math.floor(Date.now() / 1000) - 10,
        scope: 'openid email profile',
      }),
      upsertToken: async () => undefined,
      deleteToken: async () => undefined,
      deleteTokenIfRefreshTokenMatches: async (userId: string, _provider: string, refreshToken: string) => {
        deleted.push({ userId, refreshToken });
        return true;
      },
    } as any,
  };
};

const stubFetch = (t: { after: (fn: () => void) => void }, impl: typeof fetch) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const refreshFailure = async (service: GoogleOAuthService) => {
  try {
    await service.getDelegatedAccessToken('user-1');
  } catch (error) {
    return error;
  }
  assert.fail('expected the refresh to fail');
};

test('only invalid_grant is a dead grant; invalid_rapt is the session-control policy', () => {
  assert.equal(classifyGoogleRefreshFailure({ error: 'invalid_grant' }), 'reauth_required');
  assert.equal(classifyGoogleRefreshFailure({ error: 'invalid_grant', error_subtype: 'invalid_rapt' }), 'reauth_policy');
  assert.equal(classifyGoogleRefreshFailure({ error: 'invalid_client' }), 'unavailable');
  assert.equal(classifyGoogleRefreshFailure(null), 'unavailable');
});

test('a revoked grant is reported as reauth_required and removed from the store', async (t) => {
  withEnv(t, OAUTH_ENV);
  stubFetch(t, async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  const { store, deleted } = expiredTokenStore();

  const error = await refreshFailure(new GoogleOAuthService(store));

  assert.ok(error instanceof GoogleOAuthTokenMissingError);
  assert.equal(error.reason, 'reauth_required');
  assert.deepEqual(deleted, [{ userId: 'user-1', refreshToken: 'refresh-token-1' }]);
});

test('a session-control re-login is reported as reauth_policy', async (t) => {
  withEnv(t, OAUTH_ENV);
  stubFetch(t, async () => jsonResponse(400, { error: 'invalid_grant', error_subtype: 'invalid_rapt' }));
  const { store } = expiredTokenStore();

  const error = await refreshFailure(new GoogleOAuthService(store));

  assert.ok(error instanceof GoogleOAuthTokenMissingError);
  assert.equal(error.reason, 'reauth_policy');
});

test('a Google outage keeps the grant and is not reported as a re-login', async (t) => {
  withEnv(t, OAUTH_ENV);
  stubFetch(t, async () => jsonResponse(503, { error: 'backend_error' }));
  const { store, deleted } = expiredTokenStore();

  const error = await refreshFailure(new GoogleOAuthService(store));

  assert.ok(error instanceof GoogleOAuthTokenMissingError);
  assert.equal(error.reason, 'unavailable');
  assert.deepEqual(deleted, []);
});

test('a network failure is reported as unavailable, not as an unhandled error', async (t) => {
  withEnv(t, OAUTH_ENV);
  stubFetch(t, async () => {
    throw new TypeError('fetch failed');
  });
  const { store, deleted } = expiredTokenStore();

  const error = await refreshFailure(new GoogleOAuthService(store));

  assert.ok(error instanceof GoogleOAuthTokenMissingError);
  assert.equal(error.reason, 'unavailable');
  assert.deepEqual(deleted, []);
});

const policy = {
  isAdmin: false,
  skillAllowIds: [],
  mcpServerAllowIds: [],
  mcpServerDenyIds: [],
  workspaceMode: 'private' as const,
  workspaceRole: 'owner' as const,
  canWriteWorkspace: true,
};

const agentTokenFailure = async (reason: GoogleOAuthTokenMissingError['reason']) => {
  const { createAgentPolicyApi } = await import('../src/api/agent/policy');
  const googleOAuthService = {
    getDelegatedAccessToken: async () => {
      throw new GoogleOAuthTokenMissingError('refresh failed', [], reason);
    },
  } as any;
  const api = createAgentPolicyApi(googleOAuthService, {} as any);
  try {
    await api.buildAgentAuthToken({ userId: 'user-1', workspaceId: 'workspace-1', policy, skipPlanApprovals: false });
  } catch (error) {
    return error;
  }
  assert.fail('expected buildAgentAuthToken to fail');
};

test('a dead Google grant stops the run with GOOGLE_REAUTH_REQUIRED', async () => {
  const error = await agentTokenFailure('reauth_policy');

  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 403);
  assert.equal((error.details as { code?: string }).code, 'GOOGLE_REAUTH_REQUIRED');
});

test('a Google outage stops the run with 503 and does not ask for a re-login', async () => {
  const error = await agentTokenFailure('unavailable');

  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 503);
  assert.equal((error.details as { code?: string }).code, 'GOOGLE_TEMPORARILY_UNAVAILABLE');
});

test('Drive and Cloud Storage keep the original 400 in header auth, which has no Google sign-in', async () => {
  const { googleTokenErrorResponse } = await import('../src/api/files');
  for (const reason of ['not_connected', 'reauth_required', 'reauth_policy', 'unavailable'] as const) {
    const error = new GoogleOAuthTokenMissingError('Google account is not connected for this user', [], reason);
    assert.deepEqual(googleTokenErrorResponse(error, 'headers'), {
      status: 400,
      body: { error: 'Google account is not connected for this user' },
    }, reason);
  }
});

test('outside header auth a dead grant asks for a re-login and an outage does not', async () => {
  const { googleTokenErrorResponse } = await import('../src/api/files');
  for (const mode of ['oidc', 'hybrid', undefined]) {
    const dead = googleTokenErrorResponse(new GoogleOAuthTokenMissingError('x', [], 'reauth_required'), mode);
    assert.equal(dead.status, 403, String(mode));
    assert.equal((dead.body.details as { code: string }).code, 'GOOGLE_REAUTH_REQUIRED');
    const outage = googleTokenErrorResponse(new GoogleOAuthTokenMissingError('x', [], 'unavailable'), mode);
    assert.equal(outage.status, 503, String(mode));
  }
});

test('a missing scope keeps its existing reconnect answer in every mode', async () => {
  const { googleTokenErrorResponse } = await import('../src/api/files');
  for (const mode of ['headers', 'oidc']) {
    const result = googleTokenErrorResponse(new GoogleOAuthTokenMissingError('missing', ['scope-a']), mode);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'google_scope_missing');
  }
});
