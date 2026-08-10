"""Health and dependency diagnostics route."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI
from fastapi.responses import JSONResponse


def register_health_routes(
    app: FastAPI,
    dependency_diag: Dict[str, Any],
) -> None:
    @app.get("/health")
    async def health() -> dict[str, object]:
        """Lightweight liveness probe and dependency diagnostics."""
        return {
            "status": "ok",
            "service": "helpudoc-agent",
            "dependencies": dependency_diag,
        }

    @app.get("/ready")
    async def ready() -> JSONResponse:
        """Readiness fails closed when the pinned OfficeCLI dependency is unhealthy."""
        officecli = dependency_diag.get("officecli")
        ready = isinstance(officecli, dict) and officecli.get("ready") is True
        return JSONResponse(
            status_code=200 if ready else 503,
            content={
                "status": "ok" if ready else "not_ready",
                "service": "helpudoc-agent",
                "dependencies": dependency_diag,
            },
        )
