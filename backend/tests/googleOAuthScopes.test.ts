import assert from 'node:assert/strict';
import test from 'node:test';
import { resetBackendEnvCacheForTests } from '../src/config/env';
import {
  GCS_READ_SCOPE,
  GoogleOAuthService,
  GoogleOAuthTokenMissingError,
} from '../src/services/googleOAuthService';
import type { StoredOAuthToken } from '../src/services/userOAuthTokenService';

/** The scope set a user connected before the GCS connector existed would hold. */
const LEGACY_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

function withScopeEnv(t: any, scopesRaw: string): void {
  const previous = process.env.GOOGLE_OAUTH_SCOPES;
  process.env.GOOGLE_OAUTH_SCOPES = scopesRaw;
  resetBackendEnvCacheForTests();
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GOOGLE_OAUTH_SCOPES;
    } else {
      process.env.GOOGLE_OAUTH_SCOPES = previous;
    }
    resetBackendEnvCacheForTests();
  });
}

/**
 * A token store holding one live token. The access token is far from expiry so
 * `getDelegatedAccessToken` takes its cached path and never reaches the network
 * — these cases are about scope enforcement, not refresh.
 */
function tokenStoreHolding(scope: string) {
  const token: StoredOAuthToken = {
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiryDate: Math.floor(Date.now() / 1000) + 3600,
    scope,
  };
  return {
    getToken: async () => token,
    upsertToken: async () => undefined,
    deleteToken: async () => undefined,
  } as any;
}

test('a token predating the GCS scope still serves the calls that do not need it', async (t) => {
  withScopeEnv(t, LEGACY_SCOPES);
  const service = new GoogleOAuthService(tokenStoreHolding(LEGACY_SCOPES));

  const delegated = await service.getDelegatedAccessToken('user-1');

  assert.equal(delegated.accessToken, 'access-token');
  assert.equal(delegated.source, 'cached');
});

test('requireScopes rejects a token that never granted Cloud Storage', async (t) => {
  withScopeEnv(t, LEGACY_SCOPES);
  const service = new GoogleOAuthService(tokenStoreHolding(LEGACY_SCOPES));

  await assert.rejects(
    () => service.getDelegatedAccessToken('user-1', { requireScopes: [GCS_READ_SCOPE] }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthTokenMissingError);
      assert.deepEqual(error.missingScopes, [GCS_READ_SCOPE]);
      assert.match(error.message, /devstorage\.read_only/);
      return true;
    },
  );
});

test('requireScopes passes once the user has re-consented', async (t) => {
  withScopeEnv(t, LEGACY_SCOPES);
  const service = new GoogleOAuthService(tokenStoreHolding(`${LEGACY_SCOPES} ${GCS_READ_SCOPE}`));

  const delegated = await service.getDelegatedAccessToken('user-1', {
    requireScopes: [GCS_READ_SCOPE],
  });

  assert.equal(delegated.accessToken, 'access-token');
});

test('the authorize URL asks for the GCS scope even though it is not required', async (t) => {
  withScopeEnv(t, LEGACY_SCOPES);
  const previous = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  };
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
  resetBackendEnvCacheForTests();
  t.after(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = previous.clientId;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = previous.redirectUri;
    resetBackendEnvCacheForTests();
  });

  const service = new GoogleOAuthService(tokenStoreHolding(LEGACY_SCOPES));
  const url = new URL(service.getAuthStartUrl({ state: 's', codeChallenge: 'c' }));
  const requested = (url.searchParams.get('scope') || '').split(' ');

  assert.ok(requested.includes(GCS_READ_SCOPE));
  assert.ok(requested.includes('https://www.googleapis.com/auth/drive.readonly'));
  // Requested exactly once, even though it is in both lists conceptually.
  assert.equal(requested.filter((scope) => scope === GCS_READ_SCOPE).length, 1);
});
