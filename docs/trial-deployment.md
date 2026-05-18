# Customer-Env Trial Deployment

The `trial` branch supports customer-runnable images with offline signed trial licensing. A trial deployment should set `HELPUDOC_LICENSE_REQUIRED=true` and provide a signed `HELPUDOC_LICENSE_TOKEN`.

## Required Customer Values

The customer creates a Google OAuth client for their HelpUDoc URL and registers:

```txt
https://<customer-helpudoc-domain>/api/auth/google/callback
```

Configure the backend with:

```txt
AUTH_MODE=oidc
GOOGLE_OAUTH_CLIENT_ID=<customer-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<customer-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://<customer-helpudoc-domain>/api/auth/google/callback
GOOGLE_OAUTH_POST_LOGIN_REDIRECT=https://<customer-helpudoc-domain>/login
OAUTH_TOKEN_ENCRYPTION_KEY=<32-byte-base64url-key>
HELPUDOC_LICENSE_REQUIRED=true
HELPUDOC_LICENSE_TOKEN=<signed-license-jws>
HELPUDOC_LICENSE_PUBLIC_KEY=<helpudoc-license-public-key-pem>
```

## License Token

The license token is a compact RS256 JWS. The payload must include:

```json
{
  "customer": "Acme",
  "deploymentId": "acme-trial",
  "plan": "trial",
  "issuedAt": "2026-05-18T00:00:00.000Z",
  "expiresAt": "2026-06-17T00:00:00.000Z"
}
```

Optional fields:

```json
{
  "oauthClientIdSha256": "<sha256-of-google-oauth-client-id>",
  "features": ["workspace", "rag", "slides"],
  "limits": { "maxUsers": 10, "maxWorkspaces": 3 }
}
```

The private signing key must stay outside customer environments. Only the public key and signed token are deployed.

## Expiry Behavior

After `expiresAt`, HelpUDoc stays readable but blocks mutating/expensive API calls. Users can still sign in, list and view existing data, and sign out. Uploads, imports, indexing, agent runs, workspace edits, settings changes, and admin mutations return a trial-expired response.
