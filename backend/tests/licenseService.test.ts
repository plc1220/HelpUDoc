import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { LicenseService } from '../src/services/licenseService';
import { resetBackendEnvCacheForTests } from '../src/config/env';

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
  resetBackendEnvCacheForTests();
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signLicense(payload: Record<string, unknown>, privateKey: string): string {
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const body = base64urlJson(payload);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function configureLicense(payload: Record<string, unknown>, overrides: Record<string, string | undefined> = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.HELPUDOC_LICENSE_REQUIRED = 'true';
  process.env.HELPUDOC_LICENSE_PUBLIC_KEY = publicKey;
  process.env.HELPUDOC_LICENSE_TOKEN = signLicense(payload, privateKey);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetBackendEnvCacheForTests();
}

function validPayload(expiresAt = '2099-01-01T00:00:00.000Z') {
  return {
    customer: 'Acme',
    deploymentId: 'acme-trial',
    plan: 'trial',
    issuedAt: '2026-05-18T00:00:00.000Z',
    expiresAt,
    features: ['workspace'],
    limits: { maxUsers: 10 },
  };
}

test('license service is active when no trial license is required', () => {
  restoreEnv();
  delete process.env.HELPUDOC_LICENSE_REQUIRED;
  delete process.env.HELPUDOC_LICENSE_TOKEN;
  delete process.env.HELPUDOC_LICENSE_PUBLIC_KEY;
  resetBackendEnvCacheForTests();

  const state = new LicenseService().getState();
  assert.equal(state.active, true);
  assert.equal(state.status, 'not_configured');
});

test('license service rejects required deployments without a token', () => {
  restoreEnv();
  process.env.HELPUDOC_LICENSE_REQUIRED = 'true';
  delete process.env.HELPUDOC_LICENSE_TOKEN;
  resetBackendEnvCacheForTests();

  const state = new LicenseService().getState();
  assert.equal(state.active, false);
  assert.equal(state.status, 'missing');
});

test('license service accepts a valid RS256 trial token', () => {
  restoreEnv();
  configureLicense(validPayload());

  const state = new LicenseService().getState(new Date('2026-05-19T00:00:00.000Z'));
  assert.equal(state.active, true);
  assert.equal(state.status, 'active');
  assert.equal(state.configured, true);
});

test('license service marks expired trial tokens inactive', () => {
  restoreEnv();
  configureLicense(validPayload('2026-06-17T00:00:00.000Z'));

  const state = new LicenseService().getState(new Date('2026-06-17T00:00:00.000Z'));
  assert.equal(state.active, false);
  assert.equal(state.status, 'expired');
});

test('license service binds tokens to the configured Google OAuth client when requested', () => {
  restoreEnv();
  const clientId = 'customer-client.apps.googleusercontent.com';
  const oauthClientIdSha256 = crypto.createHash('sha256').update(clientId).digest('hex');
  configureLicense({ ...validPayload(), oauthClientIdSha256 }, {
    GOOGLE_OAUTH_CLIENT_ID: 'different-client.apps.googleusercontent.com',
  });

  const state = new LicenseService().getState();
  assert.equal(state.active, false);
  assert.equal(state.status, 'invalid');
});
