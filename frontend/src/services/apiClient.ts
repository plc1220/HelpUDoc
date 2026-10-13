import { getAuthUser } from '../auth/authStore';
import { AUTH_EXPIRED_EVENT, authExpiredReasonFor, canReauthWithGoogle, type AuthExpiredReason } from '../auth/authExpiry';
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

let authExpiredSignalled = false;

/** True once an expired session or Google grant was reported and not yet cleared by a sign-in. */
export function isAuthExpiredSignalled(): boolean {
  return authExpiredSignalled;
}

/** Called after a sign-in, so the next expiry is reported again. */
export function resetAuthExpiredSignal(): void {
  authExpiredSignalled = false;
}

/**
 * Many requests fail at once when a session ends (polls, streams, the page's own
 * loads). Report the first only: the sign-in prompt needs one event, not dozens.
 */
function signalAuthExpired(reason: AuthExpiredReason): void {
  if (authExpiredSignalled || typeof window === 'undefined') return;
  authExpiredSignalled = true;
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: { reason } }));
}

function requestPathname(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  try {
    return new URL(raw, origin).pathname;
  } catch {
    return raw;
  }
}

/**
 * Resolves after any expiry signal is sent, so a caller that catches the failed
 * request already sees `isAuthExpiredSignalled()`. Only a 403 needs its (small)
 * error body read; a clone keeps the body readable for the caller.
 */
async function watchForAuthExpiry(input: RequestInfo | URL, response: Response): Promise<void> {
  if (response.status !== 401 && response.status !== 403) return;
  const pathname = requestPathname(input);
  let body: unknown;
  if (response.status === 403) {
    body = await response.clone().json().catch(() => undefined);
  }
  const reason = authExpiredReasonFor(pathname, response.status, body);
  if (!reason) return;
  // A header-identity user cannot fix a Google failure by signing in again; the
  // caller shows the error instead. Not signalling also keeps the chat from
  // treating that error as a sign-in prompt and hiding it.
  if (reason === 'google' && !canReauthWithGoogle(AUTH_MODE, getAuthUser())) return;
  signalAuthExpired(reason);
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = mergeAuthHeaders(init.headers as HeadersInit | undefined);
  const response = await fetch(input, { ...init, headers, credentials: 'include' });
  await watchForAuthExpiry(input, response);
  return response;
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
