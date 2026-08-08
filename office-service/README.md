# office-service

Internal HTTP sidecar wrapping [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
(iOfficeAI/OfficeCLI v1.0.143) for structured OpenXML batch operations on DOCX,
XLSX, and PPTX documents.

## Overview

- **Not user-facing** — no ingress route, no frontend surface.
- Runs as a sidecar container in the `helpudoc-app` pod (GKE) or as a separate
  service in Docker Compose, sharing the workspace volume.
- Exposes `POST /v1/execute` for batch operations and `GET /healthz` / `GET /readyz`
  for Kubernetes probes.
- Pins OfficeCLI binary by version and SHA-256 checksum.
- Disables resident (named-pipe) mode via `OFFICECLI_NO_AUTO_RESIDENT=1` and
  auto-update via `OFFICECLI_SKIP_UPDATE=1`.

## API

### POST /v1/execute

Execute a batch of OfficeCLI operations against a workspace document.

```json
{
  "workspace_id": "abc-123",
  "source_path": "reports/quarterly.docx",
  "output_path": "reports/quarterly.docx",
  "operations": [
    {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "New Section"}},
    {"command": "set", "path": "/body/p[1]", "props": {"bold": "true"}},
    {"command": "get", "path": "/body/p[1]"}
  ],
  "create_if_missing": false,
  "validate": true,
  "best_effort": false
}
```

Response (real OfficeCLI envelope):
```json
{
  "success": true,
  "published": true,
  "results": [
    {"index": 0, "success": true, "command": "add", "output": "Added paragraph at /body/p[...]"},
    {"index": 1, "success": true, "command": "set", "output": null},
    {"index": 2, "success": true, "command": "get", "output": {"path": "/body/p[1]", "type": "paragraph", "text": "..."}}
  ],
  "summary": {"total": 3, "executed": 3, "succeeded": 3, "failed": 0, "skipped": 0},
  "validation": {"success": true, "count": 0, "errors": []},
  "officecli_version": "1.0.143",
  "duration_ms": 87,
  "warnings": []
}
```

### GET /healthz / GET /readyz

Liveness and readiness probes. Return OfficeCLI version and binary SHA-256.

## Allowed Operations

MVP allowlist: `add`, `set`, `get`, `query`, `remove`, `move`, `swap`, `view`, `validate`.

Blocked commands: `raw`, `raw-set`, `add-part`, `import`, `meta`, `open`, `close`, `save`.

Blocked fields: `file`, `output`, `input`, `src`, `dest`, `target`, `url`, `uri`, `href`, `from`.

Nested keys blocked inside props: `path`, `src`, `file`, `url`, `uri`, `href`, `fallback`.

### Trust boundary

The service assumes the shared workspace filesystem is controlled by the
co-located HelpUDoc backend/agent containers. It rejects traversal and symlink
escapes at request time and rechecks containment under the output lock before
copying or publishing. It is not designed to be exposed to an untrusted
process that can continuously race directory renames on the mounted volume;
that deployment model would require Linux `openat2`/dirfd-based file handling.

## Local Development

```bash
cd office-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
OFFICE_SERVICE_WORKSPACE_ROOT=../backend/workspaces python app.py
```

## Docker Build (from repo root)

```bash
docker build -f office-service/Dockerfile -t helpudoc-office-service .
```

The image includes the pinned upstream `LICENSE`, `NOTICE`, and
`THIRD-PARTY-NOTICES.txt` files under `/app/licenses`.

## Running Tests

```bash
cd office-service
pip install -r requirements.txt pytest httpx
# Unit + integration tests (fake binary; real-binary tests skip automatically)
pytest tests -v
# Smoke tests with real binary
OFFICECLI_BIN=/path/to/officecli pytest tests/test_smoke_real.py -v
```
