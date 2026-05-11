"""RAG query and indexing status routes."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import Body, FastAPI, HTTPException

from helpudoc_agent.rag_worker import RagIndexWorker

from ..schemas import RagQueryRequest, RagQueryResponse, RagStatusRequest, RagStatusResponse


def register_rag_routes(app: FastAPI, rag_worker: RagIndexWorker) -> None:
    @app.post("/rag/workspaces/{workspace_id}/query", response_model=RagQueryResponse)
    async def rag_query(workspace_id: str, req: RagQueryRequest = Body(...)):
        if not req.query or not req.query.strip():
            raise HTTPException(status_code=400, detail="query is required")
        try:
            response = await rag_worker.store.query(
                workspace_id,
                req.query,
                mode=req.mode,
                only_need_context=req.onlyNeedContext,
                include_references=req.includeReferences,
            )
            return RagQueryResponse(response=response)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/rag/workspaces/{workspace_id}/status", response_model=RagStatusResponse)
    async def rag_status(workspace_id: str, req: RagStatusRequest = Body(...)):
        if not req.files:
            raise HTTPException(status_code=400, detail="files is required")
        statuses: Dict[str, Any] = {}
        for name in req.files:
            if not isinstance(name, str) or not name.strip():
                continue
            relative = name.strip().lstrip("/")
            try:
                status = await rag_worker.store.get_doc_status(workspace_id, relative)
            except Exception as exc:
                status = {"status": "error", "error": str(exc)}
            if status is None:
                statuses[name] = {"status": "not_indexed"}
            else:
                statuses[name] = {
                    "status": status.get("status", "unknown"),
                    "updatedAt": status.get("updated_at"),
                    "error": status.get("error_msg"),
                }
        return RagStatusResponse(statuses=statuses)
