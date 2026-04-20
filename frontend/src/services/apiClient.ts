import { getAuthUser } from '../auth/authStore';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
export const AUTH_MODE = (import.meta.env.VITE_AUTH_MODE || 'hybrid').toLowerCase();

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
