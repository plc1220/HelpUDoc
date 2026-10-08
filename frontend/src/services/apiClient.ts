import { getAuthUser } from '../auth/authStore';
import { vitePublicEnv } from '../config/env';

export const API_URL = vitePublicEnv.apiUrl;
export const AUTH_MODE = vitePublicEnv.authMode;

export function buildApiUrl(path: string): URL {
  const base = API_URL.endsWith('/') ? API_URL.slice(0, -1) : API_URL;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  return new URL(`${base}${normalizedPath}`, origin);
}

function shouldAttachHeaderIdentity() {
  if (AUTH_MODE === 'headers') {
    return true;
  }
  if (AUTH_MODE !== 'hybrid' && AUTH_MODE !== 'auto') {
    return false;
  }

  const user = getAuthUser();
  if (!user) {
    return false;
  }

  if (user.provider === 'google') {
    return false;
  }

  if (user.provider === 'local') {
    return true;
  }

  // Older stored auth payloads may not have a provider; treat google-* identities as OIDC users.
  return !user.id.startsWith('google-');
}

function mergeAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (!shouldAttachHeaderIdentity()) {
    return headers;
  }
  const user = getAuthUser();
  if (user) {
    headers.set('X-User-Id', user.id);
    headers.set('X-User-Name', user.name);
    if (user.email) {
      headers.set('X-User-Email', user.email);
    }
  }
  return headers;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = mergeAuthHeaders(init.headers as HeadersInit | undefined);
  return fetch(input, { ...init, headers, credentials: 'include' });
}

/**
 * Saves a file the API guards behind an identity header.
 *
 * A plain navigation or `window.open` cannot carry `X-User-Id`, so under header
 * auth the request arrives anonymous and the browser saves the 401 body as the
 * file. Fetching it here keeps the header and hands the browser a blob instead.
 */
export async function downloadThroughApi(url: string, fallbackName: string): Promise<void> {
  const response = await apiFetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to download');
  }

  const disposition = response.headers.get('content-disposition') || '';
  const named = /filename="?([^"]+)"?/.exec(disposition);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = named?.[1] || fallbackName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}
