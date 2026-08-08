"""Internal synchronous client for office-service.

This is a low-level helper for skill scripts and internal agent code.
It is NOT registered in ToolFactory and is NOT exposed as a model-facing tool.

Usage from a skill script or agent helper:
    from helpudoc_agent.office_client import office_execute

    result = office_execute(
        workspace_id="ws-123",
        output_path="reports/quarterly.docx",
        operations=[
            {"command": "set", "path": "/body/p[1]", "props": {"text": "New Title"}},
            {"command": "validate"},
        ],
        source_path="reports/quarterly.docx",
    )
    assert result["success"]
    print(result["officecli_version"])
    for r in result["results"]:
        print(r["index"], r["success"], r.get("output"))
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Default URL — overridden by env in Docker Compose / GKE
_DEFAULT_URL = "http://localhost:8002"


class OfficeServiceError(Exception):
    """Raised when office-service returns a non-2xx response."""

    def __init__(self, status_code: int, error: str, detail: str | None = None):
        self.status_code = status_code
        self.error = error
        self.detail = detail
        super().__init__(f"office-service error {status_code}: {error} — {detail}")


class OfficeServiceUnavailable(Exception):
    """Raised when office-service is unreachable."""


def get_office_service_url() -> str:
    """Resolve the office-service base URL from environment."""
    return os.environ.get("OFFICE_SERVICE_URL", _DEFAULT_URL)


def office_execute(
    workspace_id: str,
    output_path: str,
    operations: list[dict[str, Any]],
    *,
    source_path: Optional[str] = None,
    create_if_missing: bool = False,
    validate: bool = True,
    best_effort: bool = False,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Execute OfficeCLI batch operations via office-service.

    Args:
        workspace_id: Workspace identifier (simple slug).
        output_path: Workspace-relative path for the output document.
        operations: List of OfficeCLI batch operation dicts.
        source_path: Workspace-relative path to source document (optional).
        create_if_missing: Create a blank document if source doesn't exist.
        validate: Run OfficeCLI validate after operations.
        best_effort: Allow partial success (non-atomic mode).
        timeout: HTTP request timeout in seconds.

    Returns:
        Parsed JSON response from office-service with structure:
        {
            "success": bool,
            "published": bool,
            "results": [{index, success, command, output?, error?, code?}, ...],
            "summary": {total, executed, succeeded, failed, skipped},
            "validation": {success, count, errors} | null,
            "officecli_version": str,
            "duration_ms": int,
            "warnings": [str]
        }

    Raises:
        OfficeServiceError: On 4xx/5xx responses.
        OfficeServiceUnavailable: On connection failure.
    """
    url = f"{get_office_service_url()}/v1/execute"
    payload: dict[str, Any] = {
        "workspace_id": workspace_id,
        "output_path": output_path,
        "operations": operations,
        "create_if_missing": create_if_missing,
        "validate": validate,
        "best_effort": best_effort,
    }
    if source_path is not None:
        payload["source_path"] = source_path

    body = json.dumps(payload).encode("utf-8")
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")

    try:
        with urlopen(req, timeout=timeout) as resp:
            resp_body = resp.read()
            return json.loads(resp_body)
    except HTTPError as e:
        resp_body = e.read().decode("utf-8", errors="replace")
        try:
            error_data = json.loads(resp_body)
        except json.JSONDecodeError:
            error_data = {"error": "unknown", "detail": resp_body[:500]}
        raise OfficeServiceError(
            status_code=e.code,
            error=error_data.get("error", "unknown"),
            detail=error_data.get("detail"),
        ) from e
    except URLError as e:
        raise OfficeServiceUnavailable(
            f"Cannot reach office-service at {url}: {e.reason}"
        ) from e


def office_healthz(timeout: float = 5.0) -> dict[str, Any]:
    """Check office-service health."""
    url = f"{get_office_service_url()}/healthz"
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (HTTPError, URLError) as e:
        raise OfficeServiceUnavailable(f"Health check failed: {e}") from e
