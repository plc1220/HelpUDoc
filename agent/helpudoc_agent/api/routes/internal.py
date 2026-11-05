"""Internal analysis and persistent memory HTTP routes."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from langchain_core.messages import HumanMessage, SystemMessage

from helpudoc_agent.configuration import Settings
from helpudoc_agent.langfuse_callbacks import langfuse_langchain_callbacks
from helpudoc_agent.memory_store import MemoryStoreManager
from helpudoc_agent.runtime.agent_registry import AgentRegistry

from ..auth_context import require_internal_user_context
from ..message_utils import _message_to_text
from ..schemas import InternalAnalyzeRequest, InternalMemoryRequest, InternalMemoryWriteRequest


def register_internal_routes(
    app: FastAPI,
    *,
    settings: Settings,
    registry: AgentRegistry,
    memory_store_manager: MemoryStoreManager,
    agent_jwt_secret: str,
) -> None:
    async def _run_internal_analysis(
        system_prompt: str, user_prompt: str, *, user_id: str | None = None, purpose: str | None = None
    ) -> str:
        model = registry._get_model(settings.model.resolve_chat_model_name("fast"))
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]
        # Chat runs pass the Langfuse callback; this model call did not, so its
        # prompt, output, tokens and cost never reached Langfuse. The trace held only
        # the HTTP request spans.
        name = f"internal-analysis:{purpose}" if purpose else "internal-analysis"
        config = {"run_name": name, "metadata": {"langfuse_tags": ["internal-analysis"]}}
        if user_id:
            config["metadata"]["langfuse_user_id"] = user_id
        callbacks = langfuse_langchain_callbacks()
        if callbacks:
            config["callbacks"] = callbacks
        if hasattr(model, "ainvoke"):
            result = await model.ainvoke(messages, config=config)
        else:
            result = model.invoke(messages, config=config)
        return _message_to_text(result)

    @app.post("/internal/analyze")
    async def internal_analyze(req: InternalAnalyzeRequest, request: Request):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if not req.systemPrompt.strip() or not req.userPrompt.strip():
            raise HTTPException(status_code=400, detail="systemPrompt and userPrompt are required")
        purpose = (req.purpose or "").strip().lower()[:64] or None
        text = await _run_internal_analysis(
            req.systemPrompt, req.userPrompt, user_id=context.get("user_id"), purpose=purpose
        )
        return {"text": text}

    @app.get("/internal/memories")
    async def get_internal_memory(path: str, request: Request):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        user_id = str(context["user_id"]).strip()
        try:
            file = memory_store_manager.read_file(user_id, path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "path": file.path,
            "exists": file.exists,
            "content": file.content,
            "modifiedAt": file.modified_at,
        }

    @app.put("/internal/memories")
    async def put_internal_memory(req: InternalMemoryWriteRequest, request: Request):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        user_id = str(context["user_id"]).strip()
        try:
            file = memory_store_manager.write_file(user_id, req.path, req.content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "path": file.path,
            "exists": file.exists,
            "content": file.content,
            "modifiedAt": file.modified_at,
        }

    @app.delete("/internal/memories")
    async def delete_internal_memory(req: InternalMemoryRequest, request: Request):
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        user_id = str(context["user_id"]).strip()
        try:
            memory_store_manager.delete_file(user_id, req.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "path": req.path}
