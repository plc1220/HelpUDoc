"""office-service — internal OfficeCLI HTTP sidecar for HelpUDoc.

Provides POST /v1/execute for batch OpenXML operations via a pinned
OfficeCLI binary. No user/team/workspace product surface; available
only to backend and agent on the pod-internal network.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import ServiceConfig
from executor import (
    OfficeCLIOutputError,
    execute_batch,
    get_binary_sha256,
    get_officecli_version,
    is_binary_ready,
)
from models import ErrorResponse, ExecuteRequest, ExecuteResponse, HealthResponse
from security import (
    InvalidOperationError,
    PathTraversalError,
    resolve_workspace_path,
    validate_extension,
    validate_operations,
)


config = ServiceConfig()
_semaphore: asyncio.Semaphore | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _semaphore
    _semaphore = asyncio.Semaphore(config.max_concurrent)
    # Warm the version cache
    get_officecli_version(config)
    get_binary_sha256(config)
    yield


app = FastAPI(
    title="office-service",
    description="Internal OfficeCLI sidecar for HelpUDoc",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/healthz", response_model=HealthResponse)
async def healthz():
    """Liveness probe: reports pinned version and binary hash."""
    return HealthResponse(
        status="ok",
        officecli_version=get_officecli_version(config),
        binary_sha256=get_binary_sha256(config),
    )


@app.get("/readyz", response_model=HealthResponse)
async def readyz():
    """Readiness probe: confirms binary is present and executable."""
    if not is_binary_ready(config):
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "officecli_version": "unavailable", "binary_sha256": ""},
        )
    return HealthResponse(
        status="ok",
        officecli_version=get_officecli_version(config),
        binary_sha256=get_binary_sha256(config),
    )


@app.post("/v1/execute", response_model=ExecuteResponse)
async def execute(request: Request):
    """Execute a batch of OfficeCLI operations against a workspace document.

    Copies source to a temp working document, runs operations, optionally
    validates, and atomically publishes to output_path on success only.
    """
    # Enforce request body size by streaming with a cap.
    # Stop reading once limit+1 bytes observed — never buffer unbounded.
    max_bytes = config.max_request_bytes
    body_chunks: list[bytes] = []
    total_read = 0
    async for chunk in request.stream():
        total_read += len(chunk)
        if total_read > max_bytes:
            return JSONResponse(
                status_code=413,
                content=ErrorResponse(
                    error="request_too_large",
                    detail=f"Request body exceeds limit of {max_bytes} bytes",
                ).model_dump(),
            )
        body_chunks.append(chunk)

    body_bytes = b"".join(body_chunks)

    try:
        body = json.loads(body_bytes)
    except Exception as e:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(error="invalid_json", detail=str(e)).model_dump(),
        )

    try:
        req = ExecuteRequest(**body)
    except Exception as e:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(error="validation_error", detail=str(e)).model_dump(),
        )

    # Validate operations
    try:
        validate_operations(req.operations, config.max_operations)
    except InvalidOperationError as e:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(error="invalid_operations", detail=str(e)).model_dump(),
        )

    # Validate extensions
    try:
        validate_extension(req.output_path, context="output_path")
        if req.source_path:
            validate_extension(req.source_path, context="source_path")
            if Path(req.source_path).suffix.lower() != Path(req.output_path).suffix.lower():
                raise InvalidOperationError(
                    "source_path and output_path must use the same Office format"
                )
    except InvalidOperationError as e:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(error="invalid_extension", detail=str(e)).model_dump(),
        )

    # Resolve paths
    try:
        workspace_base = Path(config.workspace_root) / req.workspace_id
        output_resolved = resolve_workspace_path(
            config.workspace_root, req.workspace_id, req.output_path
        )
        source_resolved = None
        if req.source_path:
            source_resolved = resolve_workspace_path(
                config.workspace_root, req.workspace_id, req.source_path
            )
    except PathTraversalError as e:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(error="path_traversal", detail=str(e)).model_dump(),
        )

    # When no source_path but output exists, use output as source (even with create_if_missing,
    # to avoid overwriting existing documents with blank ones)
    if source_resolved is None and output_resolved.exists():
        source_resolved = output_resolved

    # Execute
    try:
        assert _semaphore is not None
        response = await execute_batch(
            config=config,
            semaphore=_semaphore,
            workspace_base=workspace_base,
            source_resolved=source_resolved,
            output_resolved=output_resolved,
            operations=req.operations,
            create_if_missing=req.create_if_missing,
            run_validate=req.run_validate,
            best_effort=req.best_effort,
        )
        return response
    except FileNotFoundError as e:
        return JSONResponse(
            status_code=404,
            content=ErrorResponse(error="source_not_found", detail=str(e)).model_dump(),
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content=ErrorResponse(
                error="timeout",
                detail=f"OfficeCLI did not complete within {config.timeout_seconds}s",
            ).model_dump(),
        )
    except OfficeCLIOutputError as e:
        return JSONResponse(
            status_code=502,
            content=ErrorResponse(error="officecli_output_error", detail=str(e)).model_dump(),
        )
    except RuntimeError as e:
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(error="officecli_error", detail=str(e)).model_dump(),
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                error="internal_error", detail=f"{type(e).__name__}: {e}"
            ).model_dump(),
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.port)
