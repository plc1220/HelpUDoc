import { getAuthUser } from '../auth/authStore';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

function mergeAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
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
  return fetch(input, { ...init, headers });
}
