"""Internal lightweight document extraction route for OKF publishing."""
from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request

from helpudoc_agent.configuration import Settings
from helpudoc_agent.knowledge_ingestion.enrichment import (
    PROMPT_VERSION,
    REDUCE_PROMPT_VERSION,
    SCHEMA_VERSION,
    enrich_processing_window,
    hierarchical_reduce_enrichments,
    WindowEnrichment,
)
from helpudoc_agent.knowledge_ingestion.models import ProcessingWindow, SourceBlock
from helpudoc_agent.knowledge_ingestion.extractors import preflight_document
from helpudoc_agent.knowledge_ingestion.embeddings import (
    EmbeddingInput,
    embed_knowledge_inputs,
    embed_pdf_pages,
    embedding_model_name,
)
from helpudoc_agent.knowledge_ingestion.graph import analyze_canonical_graph
from helpudoc_agent.tools_and_schemas import GeminiClientManager
from ..auth_context import require_internal_user_context

from ..lightweight_extract import extract_workspace_document_with_gemini
from ..schemas import (
    DocumentExtractionRequest,
    DocumentExtractionResponse,
    DocumentPreflightRequest,
    KnowledgeMapRequest,
    KnowledgeMapResponse,
    KnowledgeReduceRequest,
    KnowledgeEmbeddingRequest,
    KnowledgeEmbeddingResponse,
    KnowledgeMediaEmbeddingRequest,
    KnowledgeGraphAnalysisRequest,
)


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


def register_document_routes(
    app: FastAPI,
    *,
    settings: Settings,
    gemini_manager: GeminiClientManager,
    agent_jwt_secret: str,
) -> None:
    @app.post("/documents/extract", response_model=DocumentExtractionResponse)
    async def extract_document(request: Request, req: DocumentExtractionRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
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
            return DocumentExtractionResponse(**await extract_workspace_document_with_gemini(
                candidate,
                client=gemini_manager.client,
                model=gemini_manager.lite_model_name,
                include_plan=True,
            ))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/documents/preflight")
    async def preflight(request: Request, req: DocumentPreflightRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        try:
            candidate = _resolve_workspace_document(
                Path(settings.backend.workspace_root), req.workspaceId, req.relativePath,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="Workspace file not found")
        return preflight_document(candidate)

    @app.post("/knowledge/ingestion/map", response_model=KnowledgeMapResponse)
    async def map_knowledge_window(request: Request, req: KnowledgeMapRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        try:
            window = ProcessingWindow.model_validate(req.window)
            blocks = [SourceBlock.model_validate(block) for block in req.blocks]
            usage: list[dict[str, object]] = []
            validation_warnings: list[str] = []
            result = await enrich_processing_window(
                gemini_manager.get_ingestion_chat_model(),
                window=window,
                blocks=blocks,
                source_type=req.sourceType,
                language_distribution=req.languageDistribution,
                structural_path=req.structuralPath,
                usage_records=usage,
                validation_warnings=validation_warnings,
            )
            return KnowledgeMapResponse(
                result=result.model_dump(mode="json"),
                model=gemini_manager.lite_model_name,
                promptVersion=PROMPT_VERSION,
                schemaVersion=SCHEMA_VERSION,
                usage={
                    "events": usage,
                    "inputTokens": sum(int(item.get("inputTokens") or 0) for item in usage),
                    "cachedInputTokens": sum(int(item.get("cachedInputTokens") or 0) for item in usage),
                    "outputTokens": sum(int(item.get("outputTokens") or 0) for item in usage),
                    "attempts": len(usage),
                },
                validationWarnings=validation_warnings,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/knowledge/ingestion/reduce", response_model=KnowledgeMapResponse)
    async def reduce_knowledge(request: Request, req: KnowledgeReduceRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        try:
            blocks = [SourceBlock.model_validate(block) for block in req.blocks]
            results = [
                WindowEnrichment.model_validate(item.get("result", item))
                for item in req.mapResults
            ]
            usage: list[dict[str, object]] = []
            reduced = await hierarchical_reduce_enrichments(
                gemini_manager.get_ingestion_chat_model(),
                results=results,
                blocks=blocks,
                fan_in=req.fanIn,
                usage_records=usage,
            )
            return KnowledgeMapResponse(
                result=reduced.model_dump(mode="json"),
                model=gemini_manager.lite_model_name,
                promptVersion=REDUCE_PROMPT_VERSION,
                schemaVersion=SCHEMA_VERSION,
                usage={
                    "events": usage,
                    "inputTokens": sum(int(item.get("inputTokens") or 0) for item in usage),
                    "cachedInputTokens": sum(int(item.get("cachedInputTokens") or 0) for item in usage),
                    "outputTokens": sum(int(item.get("outputTokens") or 0) for item in usage),
                    "attempts": len(usage),
                },
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/knowledge/ingestion/embed", response_model=KnowledgeEmbeddingResponse)
    async def embed_knowledge(request: Request, req: KnowledgeEmbeddingRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        try:
            inputs = [EmbeddingInput.model_validate(item) for item in req.inputs]
            embeddings = await embed_knowledge_inputs(
                gemini_manager.client,
                inputs=inputs,
                dimensions=req.dimensions,
                task_type=req.taskType,
            )
            return KnowledgeEmbeddingResponse(
                model=embedding_model_name(),
                dimensions=req.dimensions,
                embeddings=[embedding.model_dump(mode="json") for embedding in embeddings],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/knowledge/ingestion/embed-media", response_model=KnowledgeEmbeddingResponse)
    async def embed_knowledge_media(request: Request, req: KnowledgeMediaEmbeddingRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        try:
            candidate = _resolve_workspace_document(
                Path(settings.backend.workspace_root), req.workspaceId, req.relativePath,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if candidate.suffix.lower() != ".pdf" or not candidate.is_file():
            raise HTTPException(status_code=400, detail="Media embedding currently requires a workspace PDF")
        try:
            embeddings = await embed_pdf_pages(
                gemini_manager.client,
                pdf_path=candidate,
                pages=req.pages,
                dimensions=req.dimensions,
            )
            return KnowledgeEmbeddingResponse(
                model=embedding_model_name(),
                dimensions=req.dimensions,
                embeddings=[embedding.model_dump(mode="json") for embedding in embeddings],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/knowledge/ingestion/graph-analysis")
    async def analyze_knowledge_graph(request: Request, req: KnowledgeGraphAnalysisRequest = Body(...)):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != req.workspaceId:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")
        return analyze_canonical_graph(req.concepts)
