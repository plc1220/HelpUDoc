"""Internal lightweight document extraction route for OKF publishing."""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, HTTPException

from helpudoc_agent.configuration import Settings

from ..lightweight_extract import extract_workspace_document
from ..schemas import DocumentExtractionRequest, DocumentExtractionResponse


def register_document_routes(app: FastAPI, *, settings: Settings) -> None:
    @app.post("/documents/extract", response_model=DocumentExtractionResponse)
    async def extract_document(req: DocumentExtractionRequest = Body(...)):
        workspace_root = Path(settings.backend.workspace_root).resolve() / req.workspaceId
        candidate = (workspace_root / req.relativePath.lstrip("/")).resolve()
        if workspace_root not in candidate.parents and candidate != workspace_root:
            raise HTTPException(status_code=400, detail="Path must remain inside the workspace")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="Workspace file not found")
        try:
            return DocumentExtractionResponse(**extract_workspace_document(candidate))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
