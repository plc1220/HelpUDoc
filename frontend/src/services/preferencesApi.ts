import { apiFetch, API_URL } from './apiClient';

/**
 * The workspace this user last opened.
 *
 * The returned id is opaque and unverified — the server stores whatever it was
 * told, and the workspace may since have been deleted or access revoked. Always
 * resolve it through `resolveWorkspaceToRestore` against the caller's own workspace
 * list before acting on it.
 *
 * A dedicated endpoint rather than a field on `/auth/me`: in `headers` auth mode
 * `AuthProvider.refreshSession` never calls `/auth/me` at all, and the user context
 * behind it is cached per request.
 */
export async function getLastWorkspaceId(): Promise<string | null> {
  const response = await apiFetch(`${API_URL}/me/last-workspace`);
  if (!response.ok) {
    throw new Error('Failed to load last workspace preference');
  }
  const payload = await response.json();
  return typeof payload?.workspaceId === 'string' ? payload.workspaceId : null;
}

export async function setLastWorkspaceId(workspaceId: string | null): Promise<void> {
  const response = await apiFetch(`${API_URL}/me/last-workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    throw new Error('Failed to save last workspace preference');
  }
}
