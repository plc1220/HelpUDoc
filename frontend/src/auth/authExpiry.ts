/**
 * Detects that a signed-in user can no longer act, from the API's answer.
 *
 * Two different things expire, and the UI looked signed in through both:
 * - `session`: the app session is gone. Every `/api` route answers 401.
 * - `google`: the session is fine, but the stored Google grant is dead. Agent and
 *   Drive routes answer 403 with `GOOGLE_REAUTH_REQUIRED`.
 * Signing in again fixes both: sign-in always asks Google for a new grant.
 */
export type AuthExpiredReason = 'session' | 'google';

export const AUTH_EXPIRED_EVENT = 'helpudoc:auth-expired';

/** `/api/auth/*` answers about sign-in itself; its failures are not an expired session. */
export const isSessionGuardedPath = (pathname: string): boolean =>
  pathname.includes('/api/') && !pathname.includes('/api/auth/');

const errorCodeOf = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { code?: unknown; details?: { code?: unknown } };
  const code = record.details?.code ?? record.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Whether signing in again can give this user a Google grant.
 *
 * Header-identity users (local `headers` mode, and `local` users in `hybrid`) never
 * hold one. Prompting them would sign them out, and the next Google call would do it
 * again: a loop. They get the error message instead. `oidc` (the deployed build)
 * signs everyone in with Google, so it does not depend on the stored user.
 */
export const canReauthWithGoogle = (
  authMode: string,
  user: { id: string; provider?: string } | null,
): boolean => {
  if (authMode === 'oidc') return true;
  if (authMode === 'headers' || !user) return false;
  if (user.provider) return user.provider === 'google';
  return user.id.startsWith('google-');
};

export const authExpiredReasonFor = (
  pathname: string,
  status: number,
  body?: unknown,
): AuthExpiredReason | null => {
  if (!isSessionGuardedPath(pathname)) return null;
  if (status === 401) return 'session';
  if (status === 403 && errorCodeOf(body) === 'GOOGLE_REAUTH_REQUIRED') return 'google';
  return null;
};
