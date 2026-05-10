/**
 * Typed access to Vite `import.meta.env` (values are fixed at build time).
 */

function trimValue(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const t = value.trim();
  return t === '' ? undefined : t;
}

const raw = import.meta.env;

function parseDebugStream(): boolean {
  const v = trimValue(raw.VITE_DEBUG_STREAM);
  return v === '1' || v?.toLowerCase() === 'true';
}

export const vitePublicEnv = {
  apiUrl: trimValue(raw.VITE_API_URL) ?? 'http://localhost:3000/api',
  authMode: (trimValue(raw.VITE_AUTH_MODE) ?? 'hybrid').toLowerCase(),
  collabUrl: trimValue(raw.VITE_COLLAB_URL) ?? 'ws://localhost:1234',
  googleClientId: trimValue(raw.VITE_GOOGLE_CLIENT_ID) ?? '',
  debugStream: parseDebugStream(),
} as const;

export type VitePublicEnv = typeof vitePublicEnv;
