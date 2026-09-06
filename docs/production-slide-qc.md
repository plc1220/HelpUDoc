# Production slide QC

The production slide smoke test uses a genuine OIDC session. Production must not enable the local `X-User-*` identity headers for test automation.

## One-time authentication

Use a dedicated, least-privilege QA Google account. On a machine where you can complete the Google login in Playwright's Chromium, save its browser state outside the repository:

```bash
cd frontend
mkdir -p "$TMPDIR/helpudoc-playwright"
npx playwright codegen --save-storage="$TMPDIR/helpudoc-playwright/production-auth.json" https://www.lc-demo.com/
```

Complete login, then close the codegen browser. Never commit the saved state; it contains an authenticated session. A signed `helpudoc.sid` value can instead be supplied through `E2E_SESSION_COOKIE`, but the storage-state file is preferred because it does not put the secret in shell history.

## Run the smoke test

```bash
cd frontend
E2E_BASE_URL=https://www.lc-demo.com \
E2E_STORAGE_STATE="$TMPDIR/helpudoc-playwright/production-auth.json" \
npm run e2e:production:slides
```

The test creates a disposable workspace and brief, starts `frontend-slides` through the real UI, answers the deck-mode gate, validates at least three embedded style previews, chooses a style, waits for completion, validates the final HTML deck, checks that PowerPoint export was not attempted, attaches screenshots and JSON evidence, and deletes the workspace.

Playwright retains traces and screenshots under `frontend/test-results` when the test fails. If authentication has expired, the test fails at `/api/auth/me`; repeat the one-time authentication step rather than weakening production authentication.
