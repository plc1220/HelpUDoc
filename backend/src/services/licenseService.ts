import crypto from 'crypto';
import { z } from 'zod';
import { getBackendEnv } from '../config/env';

const licensePayloadSchema = z.object({
  customer: z.string().min(1),
  deploymentId: z.string().min(1),
  plan: z.literal('trial'),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  oauthClientIdSha256: z.string().optional(),
  features: z.array(z.string()).optional(),
  limits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

export type LicenseState =
  | { configured: false; required: false; active: true; status: 'not_configured' }
  | { configured: false; required: true; active: false; status: 'missing'; message: string }
  | { configured: true; required: boolean; active: true; status: 'active'; payload: LicensePayload; expiresAt: string }
  | { configured: true; required: boolean; active: false; status: 'expired' | 'invalid'; message: string; payload?: LicensePayload; expiresAt?: string };

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function publicLicenseView(state: LicenseState) {
  if (state.status === 'active') {
    return {
      configured: true,
      required: state.required,
      active: true,
      status: state.status,
      customer: state.payload.customer,
      deploymentId: state.payload.deploymentId,
      plan: state.payload.plan,
      expiresAt: state.expiresAt,
      features: state.payload.features || [],
      limits: state.payload.limits || {},
    };
  }
  return {
    configured: state.configured,
    required: state.required,
    active: state.active,
    status: state.status,
    expiresAt: 'expiresAt' in state ? state.expiresAt : undefined,
    message: 'message' in state ? state.message : undefined,
  };
}

export type PublicLicenseView = ReturnType<typeof publicLicenseView>;

export class LicenseService {
  private cached: LicenseState | null = null;

  getState(now = new Date()): LicenseState {
    if (!this.cached) {
      this.cached = this.loadState();
    }
    return this.evaluateTime(this.cached, now);
  }

  getPublicState(now = new Date()): PublicLicenseView {
    return publicLicenseView(this.getState(now));
  }

  resetForTests(): void {
    this.cached = null;
  }

  private loadState(): LicenseState {
    const env = getBackendEnv();
    const { required, token, publicKey } = env.license;
    if (!token) {
      if (required) {
        return {
          configured: false,
          required,
          active: false,
          status: 'missing',
          message: 'HELPUDOC_LICENSE_TOKEN is required for this deployment',
        };
      }
      return { configured: false, required, active: true, status: 'not_configured' };
    }
    if (!publicKey) {
      return {
        configured: true,
        required,
        active: false,
        status: 'invalid',
        message: 'HELPUDOC_LICENSE_PUBLIC_KEY is required when HELPUDOC_LICENSE_TOKEN is set',
      };
    }

    try {
      const payload = this.verifyToken(token, publicKey);
      const oauthFingerprint = payload.oauthClientIdSha256;
      const oauthClientId = env.googleOauth.clientId;
      if (oauthFingerprint) {
        const actual = crypto.createHash('sha256').update(oauthClientId || '').digest('hex');
        if (!oauthClientId || actual !== oauthFingerprint.toLowerCase()) {
          return {
            configured: true,
            required,
            active: false,
            status: 'invalid',
            message: 'License OAuth client fingerprint does not match this deployment',
            payload,
            expiresAt: payload.expiresAt,
          };
        }
      }
      return this.evaluateTime({
        configured: true,
        required,
        active: true,
        status: 'active',
        payload,
        expiresAt: payload.expiresAt,
      });
    } catch (error) {
      return {
        configured: true,
        required,
        active: false,
        status: 'invalid',
        message: error instanceof Error ? error.message : 'Invalid license token',
      };
    }
  }

  private verifyToken(token: string, publicKey: string): LicensePayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('License token must be a compact JWS');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(decodeBase64Url(encodedHeader).toString('utf8')) as { alg?: string };
    if (header.alg !== 'RS256') {
      throw new Error('License token must use RS256');
    }
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    const ok = verifier.verify(publicKey, decodeBase64Url(encodedSignature));
    if (!ok) {
      throw new Error('License signature verification failed');
    }
    return licensePayloadSchema.parse(JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')));
  }

  private evaluateTime(state: LicenseState, now = new Date()): LicenseState {
    if (state.status !== 'active') {
      return state;
    }
    const expiry = Date.parse(state.payload.expiresAt);
    if (!Number.isFinite(expiry)) {
      return {
        configured: true,
        required: state.required,
        active: false,
        status: 'invalid',
        message: 'License expiresAt is not a valid timestamp',
        payload: state.payload,
        expiresAt: state.payload.expiresAt,
      };
    }
    if (now.getTime() >= expiry) {
      return {
        configured: true,
        required: state.required,
        active: false,
        status: 'expired',
        message: 'Trial expired. Contact HelpUDoc to continue.',
        payload: state.payload,
        expiresAt: state.payload.expiresAt,
      };
    }
    return state;
  }
}

export const licenseService = new LicenseService();
