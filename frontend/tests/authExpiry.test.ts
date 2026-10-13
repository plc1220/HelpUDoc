import assert from 'node:assert/strict';
import test from 'node:test';

import { authExpiredReasonFor, canReauthWithGoogle } from '../src/auth/authExpiry.ts';
import { saveComposerDraft, takeComposerDraft } from '../src/utils/composerDraft.ts';

test('a 401 from an API route means the session expired', () => {
  assert.equal(authExpiredReasonFor('/api/agent/runs', 401), 'session');
  assert.equal(authExpiredReasonFor('/api/workspaces/w1/files', 401), 'session');
});

test('sign-in routes never trigger the prompt, which would loop on /login', () => {
  assert.equal(authExpiredReasonFor('/api/auth/me', 401), null);
  assert.equal(authExpiredReasonFor('/api/auth/logout', 401), null);
});

test('a 403 is an expired Google sign-in only with GOOGLE_REAUTH_REQUIRED', () => {
  assert.equal(authExpiredReasonFor('/api/agent/runs', 403, { error: 'x', details: { code: 'GOOGLE_REAUTH_REQUIRED' } }), 'google');
  assert.equal(authExpiredReasonFor('/api/agent/runs', 403, { error: 'Access denied' }), null);
  assert.equal(authExpiredReasonFor('/api/agent/runs', 403, undefined), null);
});

test('other statuses and non-API URLs are ignored', () => {
  assert.equal(authExpiredReasonFor('/api/agent/runs', 503, { details: { code: 'GOOGLE_TEMPORARILY_UNAVAILABLE' } }), null);
  assert.equal(authExpiredReasonFor('/assets/app.js', 401), null);
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

test('a saved draft comes back once, for the same workspace', () => {
  const storage = memoryStorage();
  saveComposerDraft(storage, 'ws-1', 'Summarise the Q3 report', 1_000);

  assert.equal(takeComposerDraft(storage, 'ws-2', 2_000), null);
  assert.equal(takeComposerDraft(storage, 'ws-1', 2_000), 'Summarise the Q3 report');
  assert.equal(takeComposerDraft(storage, 'ws-1', 3_000), null);
});

test('an empty draft does not overwrite a saved one', () => {
  const storage = memoryStorage();
  saveComposerDraft(storage, 'ws-1', 'keep me', 1_000);
  saveComposerDraft(storage, 'ws-1', '   ', 1_500);

  assert.equal(takeComposerDraft(storage, 'ws-1', 2_000), 'keep me');
});

test('a draft older than a day is dropped', () => {
  const storage = memoryStorage();
  saveComposerDraft(storage, 'ws-1', 'stale', 0);

  assert.equal(takeComposerDraft(storage, 'ws-1', 25 * 60 * 60 * 1000), null);
});

test('the deployed oidc build always treats a dead Google grant as a sign-in prompt', () => {
  assert.equal(canReauthWithGoogle('oidc', null), true);
  assert.equal(canReauthWithGoogle('oidc', { id: 'google-123', provider: 'google' }), true);
});

test('header users never get a Google sign-in prompt, which would loop', () => {
  assert.equal(canReauthWithGoogle('headers', { id: 'local-qa', provider: 'local' }), false);
  assert.equal(canReauthWithGoogle('headers', { id: 'google-123', provider: 'google' }), false);
  assert.equal(canReauthWithGoogle('hybrid', { id: 'local-qa', provider: 'local' }), false);
  assert.equal(canReauthWithGoogle('hybrid', null), false);
});

test('hybrid prompts Google users, including stored users from before provider existed', () => {
  assert.equal(canReauthWithGoogle('hybrid', { id: 'google-123', provider: 'google' }), true);
  assert.equal(canReauthWithGoogle('hybrid', { id: 'google-123' }), true);
  assert.equal(canReauthWithGoogle('auto', { id: 'alice@example.com' }), false);
});
