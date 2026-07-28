"""Internal lightweight document extraction route for OKF publishing."""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, HTTPException

from helpudoc_agent.configuration import Settings

from ..lightweight_extract import extract_workspace_document
from ..schemas import DocumentExtractionRequest, DocumentExtractionResponse


def _resolve_workspace_document(
    workspace_storage_root: Path,
    workspace_id: str,
    relative_path: str,
) -> Path:
    storage_root = workspace_storage_root.resolve()
    identifier = str(workspace_id or "").strip()
    if not identifier:
        raise ValueError("workspaceId is required")

    workspace_root = (storage_root / identifier).resolve()
    if storage_root not in workspace_root.parents:
        raise ValueError("workspaceId must remain inside the workspace root")

    candidate = (workspace_root / str(relative_path or "").lstrip("/")).resolve()
    if workspace_root not in candidate.parents and candidate != workspace_root:
        raise ValueError("Path must remain inside the workspace")
    return candidate


def register_document_routes(app: FastAPI, *, settings: Settings) -> None:
    @app.post("/documents/extract", response_model=DocumentExtractionResponse)
    async def extract_document(req: DocumentExtractionRequest = Body(...)):
        try:
            candidate = _resolve_workspace_document(
                Path(settings.backend.workspace_root),
                req.workspaceId,
                req.relativePath,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="Workspace file not found")
        try:
            return DocumentExtractionResponse(**extract_workspace_document(candidate))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
