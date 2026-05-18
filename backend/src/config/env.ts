/**
 * Typed backend environment derived from process.env.
 * Call getBackendEnv() after dotenv has run (see src/index.ts).
 */

import { z } from 'zod';

function trimEnv(e: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = e[key];
  if (v === undefined) {
    return undefined;
  }
  const t = v.trim();
  return t === '' ? undefined : t;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function resolveCookieSecure(e: NodeJS.ProcessEnv): boolean {
  const raw = (trimEnv(e, 'SESSION_COOKIE_SECURE') || '').toLowerCase();
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return (trimEnv(e, 'NODE_ENV') || '').toLowerCase() === 'production';
}

function resolveSaveUninitialized(e: NodeJS.ProcessEnv): boolean {
  const raw = (trimEnv(e, 'SESSION_SAVE_UNINITIALIZED') || '').toLowerCase();
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return false;
}

const backendEnvSchema = z.object({
  nodeEnv: z.string().optional(),
  port: z.number().int().positive(),
  session: z.object({
    name: z.string().min(1),
    secret: z.string().min(1),
    ttlSeconds: z.number().int().positive(),
    cookieDomain: z.string().optional(),
    cookieSecure: z.boolean(),
    saveUninitialized: z.boolean(),
  }),
  database: z.object({
    poolMin: z.number().int().nonnegative(),
    poolMax: z.number().int().positive(),
    connectionString: z.string().min(1).optional(),
    host: z.string().min(1),
    port: z.number().int().positive(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    sslRaw: z.string().optional(),
  }),
  s3: z.object({
    bucketName: z.string().min(1),
    endpoint: z.string().min(1),
    forcePathStyle: z.boolean(),
    hasCustomEndpoint: z.boolean(),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    publicBaseUrl: z.string().min(1),
  }),
  googleOauth: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().optional(),
    postLoginRedirect: z.string().optional(),
    scopesRaw: z.string().optional(),
  }),
  license: z.object({
    required: z.boolean(),
    token: z.string().optional(),
    publicKey: z.string().optional(),
  }),
  frontendUrl: z.string().optional(),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;

let cached: BackendEnv | null = null;

/** For tests that mutate process.env between cases. */
export function resetBackendEnvCacheForTests(): void {
  cached = null;
}

export function parseBackendEnv(e: NodeJS.ProcessEnv = process.env): BackendEnv {
  const port = parsePositiveInt(trimEnv(e, 'PORT'), 3000);
  const sessionTtl = parsePositiveInt(trimEnv(e, 'SESSION_TTL_SECONDS'), 60 * 60 * 24 * 7);

  const connectionString = trimEnv(e, 'DATABASE_URL');
  const endpoint =
    trimEnv(e, 'S3_ENDPOINT')
    || trimEnv(e, 'MINIO_ENDPOINT')
    || 'http://localhost:9000';
  const hasCustomEndpoint = Boolean(trimEnv(e, 'S3_ENDPOINT') || trimEnv(e, 'MINIO_ENDPOINT'));
  const forcePathStyle =
    trimEnv(e, 'S3_FORCE_PATH_STYLE') === 'true'
    || (!trimEnv(e, 'S3_FORCE_PATH_STYLE') && hasCustomEndpoint);

  const bucket = trimEnv(e, 'S3_BUCKET_NAME') || 'helpudoc';
  const publicBase =
    trimEnv(e, 'S3_PUBLIC_BASE_URL')
    || `${endpoint.replace(/\/$/, '')}/${bucket}`;

  const raw: BackendEnv = {
    nodeEnv: trimEnv(e, 'NODE_ENV'),
    port,
    session: {
      name: trimEnv(e, 'SESSION_NAME') || 'helpudoc.sid',
      secret: trimEnv(e, 'SESSION_SECRET') || 'dev-secret-change-me',
      ttlSeconds: sessionTtl,
      cookieDomain: trimEnv(e, 'SESSION_COOKIE_DOMAIN'),
      cookieSecure: resolveCookieSecure(e),
      saveUninitialized: resolveSaveUninitialized(e),
    },
    database: {
      poolMin: parseNonNegativeInt(trimEnv(e, 'DB_POOL_MIN'), 0),
      poolMax: parsePositiveInt(trimEnv(e, 'DB_POOL_MAX'), 10),
      connectionString,
      host: trimEnv(e, 'POSTGRES_HOST') || 'localhost',
      port: parsePositiveInt(trimEnv(e, 'POSTGRES_PORT'), 5432),
      database: trimEnv(e, 'POSTGRES_DB') || 'helpudoc',
      user: trimEnv(e, 'POSTGRES_USER') || 'helpudoc',
      password: trimEnv(e, 'POSTGRES_PASSWORD') || 'helpudoc',
      sslRaw: trimEnv(e, 'DATABASE_SSL'),
    },
    s3: {
      bucketName: bucket,
      endpoint,
      forcePathStyle,
      hasCustomEndpoint,
      region: trimEnv(e, 'AWS_REGION') || 'us-east-1',
      accessKeyId:
        trimEnv(e, 'AWS_ACCESS_KEY_ID')
        || trimEnv(e, 'MINIO_ROOT_USER')
        || 'minioadmin',
      secretAccessKey:
        trimEnv(e, 'AWS_SECRET_ACCESS_KEY')
        || trimEnv(e, 'MINIO_ROOT_PASSWORD')
        || 'minioadmin',
      publicBaseUrl: publicBase,
    },
    googleOauth: {
      clientId: trimEnv(e, 'GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: trimEnv(e, 'GOOGLE_OAUTH_CLIENT_SECRET'),
      redirectUri: trimEnv(e, 'GOOGLE_OAUTH_REDIRECT_URI'),
      postLoginRedirect: trimEnv(e, 'GOOGLE_OAUTH_POST_LOGIN_REDIRECT'),
      scopesRaw: trimEnv(e, 'GOOGLE_OAUTH_SCOPES'),
    },
    license: {
      required: (trimEnv(e, 'HELPUDOC_LICENSE_REQUIRED') || '').toLowerCase() === 'true',
      token: trimEnv(e, 'HELPUDOC_LICENSE_TOKEN'),
      publicKey: trimEnv(e, 'HELPUDOC_LICENSE_PUBLIC_KEY'),
    },
    frontendUrl: trimEnv(e, 'FRONTEND_URL'),
  };

  return backendEnvSchema.parse(raw);
}

export function getBackendEnv(): BackendEnv {
  if (!cached) {
    cached = parseBackendEnv();
  }
  return cached;
}
