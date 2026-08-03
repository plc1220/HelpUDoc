import assert from 'node:assert/strict';
import test from 'node:test';

import { userContextMiddleware } from '../src/middleware/userContext';

test('production hybrid mode never accepts an untrusted X-User-Id header', async () => {
  const previousMode = process.env.AUTH_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.AUTH_MODE = 'hybrid';
  process.env.NODE_ENV = 'production';

  let ensureUserCalled = false;
  const middleware = userContextMiddleware({
    ensureUser: async () => {
      ensureUserCalled = true;
      throw new Error('Header identities must not be accepted in production');
    },
  } as any);
  const req = {
    session: {},
    header: (name: string) => name.toLowerCase() === 'x-user-id' ? 'another-user' : undefined,
  } as any;
  const res = { locals: {} } as any;

  await new Promise<void>((resolve, reject) => {
    middleware(req, res, (error?: unknown) => error ? reject(error) : resolve());
  });

  assert.equal(ensureUserCalled, false);
  assert.equal(req.userContext, undefined);

  if (previousMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previousMode;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
});

test('local header mode remains available for development fixtures', async () => {
  const previousMode = process.env.AUTH_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.AUTH_MODE = 'headers';
  process.env.NODE_ENV = 'test';

  const middleware = userContextMiddleware({
    ensureUser: async () => ({
      id: 'user-1',
      externalId: 'local-user',
      displayName: 'Local User',
      email: null,
      isAdmin: false,
    }),
  } as any);
  const req = {
    session: {},
    header: (name: string) => name.toLowerCase() === 'x-user-id' ? 'local-user' : undefined,
  } as any;
  const res = { locals: {} } as any;

  await new Promise<void>((resolve, reject) => {
    middleware(req, res, (error?: unknown) => error ? reject(error) : resolve());
  });

  assert.equal(req.userContext?.userId, 'user-1');
  assert.equal(req.userContext?.externalId, 'local-user');

  if (previousMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previousMode;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
});
