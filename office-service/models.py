"""Pydantic request/response models for POST /v1/execute."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Allowed batch commands for MVP (safe OpenXML manipulations).
# Blocked: raw, raw-set, add-part, import, meta, open, close, save, watch, unwatch, refresh
# ---------------------------------------------------------------------------
ALLOWED_COMMANDS = frozenset(
    {"add", "set", "get", "query", "remove", "move", "swap", "view", "validate"}
)

# ---------------------------------------------------------------------------
# Per-command field allowlists. Only these sibling fields (besides "command"/"op")
# are permitted for each verb. Derived from actual OfficeCLI BatchItem dispatch.
# ---------------------------------------------------------------------------
COMMAND_FIELD_ALLOWLISTS: dict[str, frozenset[str]] = {
    "add": frozenset({"path", "parent", "type", "props", "after", "before", "index"}),
    "set": frozenset({"path", "props"}),
    "get": frozenset({"path", "depth"}),
    "query": frozenset({"selector", "path", "text"}),
    "remove": frozenset({"path", "props"}),
    "move": frozenset({"path", "to", "after", "before", "index", "props"}),
    "swap": frozenset({"path", "path2", "to"}),
    "view": frozenset({"mode"}),
    "validate": frozenset(),
}

# ---------------------------------------------------------------------------
# Fields that could allow filesystem or network access — blocked at top level.
# ---------------------------------------------------------------------------
BLOCKED_FIELDS = frozenset(
    {"file", "output", "input", "src", "dest", "target", "url", "uri", "href", "from"}
)

# ---------------------------------------------------------------------------
# Keys inside nested dicts (e.g. props) that could reference filesystem or network.
# "path" is included here — it is legal only as a top-level command field.
# ---------------------------------------------------------------------------
BLOCKED_NESTED_KEYS = frozenset(
    {"src", "file", "path", "url", "uri", "href", "fallback"}
)


class ExecuteRequest(BaseModel):
    """Request body for POST /v1/execute."""

    workspace_id: str = Field(..., pattern=r"^[a-zA-Z0-9_\-]+$", max_length=128)
    source_path: Optional[str] = Field(default=None, description="Workspace-relative source document")
    output_path: str = Field(..., description="Workspace-relative output document path")
    operations: list[dict[str, Any]] = Field(..., min_length=1)
    create_if_missing: bool = Field(default=False)
    run_validate: bool = Field(
        default=True,
        alias="validate",
        description="Run OfficeCLI validate after operations",
    )
    best_effort: bool = Field(default=False)

    model_config = {"populate_by_name": True, "extra": "forbid"}


class OperationResult(BaseModel):
    """Result for a single operation within a batch."""

    index: int
    success: bool
    command: str
    output: Any = None
    error: Optional[str] = None
    code: Optional[str] = None


class BatchSummary(BaseModel):
    """Summary from OfficeCLI batch results."""

    total: int = 0
    executed: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    atomic_rolled_back: bool = Field(default=False, alias="atomicRolledBack")

    model_config = {"populate_by_name": True}


class ValidationResult(BaseModel):
    """Result from OfficeCLI validate."""

    success: bool
    count: int = 0
    errors: list[Any] = Field(default_factory=list)


class ExecuteResponse(BaseModel):
    """Response body for POST /v1/execute."""

    success: bool
    published: bool = False
    results: list[OperationResult] = Field(default_factory=list)
    summary: Optional[BatchSummary] = None
    validation: Optional[ValidationResult] = None
    officecli_version: str
    duration_ms: int
    warnings: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """Response body for GET /healthz."""

    status: str
    officecli_version: str
    binary_sha256: str


class ErrorResponse(BaseModel):
    """Standard error response."""

    error: str
    detail: Optional[str] = None
