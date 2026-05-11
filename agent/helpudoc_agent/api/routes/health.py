"""Health and dependency diagnostics route."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI


def register_health_routes(app: FastAPI, dependency_diag: Dict[str, Any]) -> None:
    @app.get("/health")
    async def health() -> dict[str, object]:
        """Lightweight liveness/readiness probe for orchestrators and deploy smoke tests."""
        return {
            "status": "ok",
            "service": "helpudoc-agent",
            "dependencies": dependency_diag,
        }
