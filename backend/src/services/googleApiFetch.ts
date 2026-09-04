import { HttpError } from '../errors';

/**
 * Authenticated reads against Google's REST APIs with a user's delegated access
 * token. Shared by the Drive and Cloud Storage connectors, which both need the
 * same thing: propagate Google's status code rather than collapsing every
 * upstream failure into a 500, and keep the upstream body short enough to log.
 */

const MAX_UPSTREAM_BODY_CHARS = 300;

async function assertOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const text = await response.text();
  throw new HttpError(
    response.status,
    `${fallbackMessage} (${response.status}): ${text.slice(0, MAX_UPSTREAM_BODY_CHARS)}`,
  );
}

export async function fetchGoogleJson<T>(
  accessToken: string,
  url: string,
  fallbackMessage: string,
): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, fallbackMessage);
  return response.json() as Promise<T>;
}

export async function fetchGoogleBuffer(
  accessToken: string,
  url: string,
  fallbackMessage: string,
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, fallbackMessage);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
