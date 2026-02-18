"""FastAPI surface for the DeepAgents service."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, AsyncGenerator, Iterable, Sequence, Set, Optional
import json
import logging
import os
import fnmatch
import mimetypes
import re
from pathlib import Path
from uuid import uuid4
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException, Body, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .configuration import load_settings
from .graph import AgentRegistry
from .state import AgentRuntimeState
from .tools_and_schemas import ToolFactory, GeminiClientManager
from .mcp_manager import describe_mcp_servers
from .utils import SourceTracker
from langchain_core.callbacks.base import AsyncCallbackHandler
from .rag_worker import RagIndexWorker
from .skills_registry import collect_tool_names, load_skills
from .paper2slides_runner import run_paper2slides, export_pptx_from_pdf
from .jwt_utils import decode_and_verify_hs256_jwt
from langgraph.types import Command


logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False


class ChatResponse(BaseModel):
    reply: Any


class Action(BaseModel):
    name: str
    args: Dict[str, Any] = Field(default_factory=dict)


class Decision(BaseModel):
    type: str
    edited_action: Optional[Action] = None
    message: Optional[str] = None


class ResumeChatRequest(BaseModel):
    decisions: List[Decision]


class RagQueryRequest(BaseModel):
    query: str
    mode: str = "local"
    onlyNeedContext: bool = True
    includeReferences: bool = False


class RagQueryResponse(BaseModel):
    response: str


class RagStatusRequest(BaseModel):
    files: List[str]


class RagStatusResponse(BaseModel):
    statuses: Dict[str, Any]


class Paper2SlidesFile(BaseModel):
    name: str
    contentB64: str


class Paper2SlidesOptions(BaseModel):
    output: str | None = None
    content: str | None = None
    style: str | None = None
    length: str | None = None
    mode: str | None = None
    parallel: int | bool | None = None
    fromStage: str | None = None
    exportPptx: bool | None = None


class Paper2SlidesImage(BaseModel):
    name: str
    contentB64: str


class Paper2SlidesRunRequest(BaseModel):
    files: List[Paper2SlidesFile]
    options: Paper2SlidesOptions = Field(default_factory=Paper2SlidesOptions)


class Paper2SlidesRunResponse(BaseModel):
    pdfB64: str | None = None
    pptxB64: str | None = None
    images: List[Paper2SlidesImage] = []


class Paper2SlidesExportRequest(BaseModel):
    fileName: str
    contentB64: str


class Paper2SlidesExportResponse(BaseModel):
    pptxB64: str


BASE_DIR = Path(__file__).resolve().parent


_FILE_RESULT_PATTERNS = [
    re.compile(r"Updated file (?P<path>/[^\s]+)"),
    re.compile(r"in '(?P<path>/[^']+)'"),
    re.compile(r"Appended (?P<src>/[^\s]+) to (?P<dst>/[^\s]+)"),
]


def _infer_mime_type(file_path: str) -> str:
    guessed, _ = mimetypes.guess_type(file_path)
    return guessed or "application/octet-stream"


def _extract_output_files_from_tool_result(name: str, text: str) -> List[Dict[str, Any]]:
    if not text:
        return []
    outputs: List[Dict[str, Any]] = []
    if name == "write_file":
        match = _FILE_RESULT_PATTERNS[0].search(text)
        if match:
            path = match.group("path")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "edit_file":
        match = _FILE_RESULT_PATTERNS[1].search(text)
        if match:
            path = match.group("path")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "append_to_report":
        match = _FILE_RESULT_PATTERNS[2].search(text)
        if match:
            path = match.group("dst")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    return outputs


def _load_env_files() -> None:
    """Load environment variables from known locations.

    We prioritize the agent's .env (agent/.env) and then allow any existing
    process-level env vars to remain.
    """
    env_file = os.getenv("ENV_FILE")
    if env_file:
        load_dotenv(env_file)
        return
    load_dotenv(BASE_DIR.parent / ".env")


def create_app() -> FastAPI:
    _load_env_files()
    config_path: Optional[Path] = None
    env_config_path = os.getenv("AGENT_CONFIG_PATH")
    if env_config_path:
        candidate = Path(env_config_path)
        if candidate.exists():
            config_path = candidate
        else:
            logger.warning("AGENT_CONFIG_PATH is set but file does not exist; falling back to built-in config", extra={"path": env_config_path})

    settings = load_settings(config_path)
    source_tracker = SourceTracker()
    gemini_manager = GeminiClientManager(settings)
    tool_factory = ToolFactory(settings, source_tracker, gemini_manager)
    registry = AgentRegistry(settings, tool_factory)
    agent_jwt_secret = os.getenv("AGENT_JWT_SECRET", "")

    app = FastAPI(title="DeepAgents Service", version="0.2.0")
    rag_worker = RagIndexWorker(settings.backend.workspace_root)

    @app.on_event("startup")
    async def _startup() -> None:
        try:
            await rag_worker.start()
        except Exception:
            logger.exception("Failed to start RAG index worker (continuing without it)")

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        try:
            await rag_worker.stop()
        except Exception:
            logger.exception("Failed to stop RAG index worker cleanly")

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

    @app.post("/paper2slides/run", response_model=Paper2SlidesRunResponse)
    async def paper2slides_run(req: Paper2SlidesRunRequest = Body(...)):
        if not req.files:
            raise HTTPException(status_code=400, detail="files is required")
        try:
            payload_files = [file.model_dump() for file in req.files]
            options = req.options.model_dump()
            result = await asyncio.to_thread(run_paper2slides, payload_files, options)
            return Paper2SlidesRunResponse(**result)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/paper2slides/export-pptx", response_model=Paper2SlidesExportResponse)
    async def paper2slides_export(req: Paper2SlidesExportRequest = Body(...)):
        if not req.contentB64:
            raise HTTPException(status_code=400, detail="contentB64 is required")
        try:
            result = await asyncio.to_thread(export_pptx_from_pdf, req.fileName, req.contentB64)
            return Paper2SlidesExportResponse(**result)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/agents")
    def list_agents():
        skills = load_skills(settings.backend.skills_root) if settings.backend.skills_root else []
        tool_names = collect_tool_names(skills)
        if tool_names:
            tool_names = [name for name in tool_names if name in settings.tools]
        if not tool_names:
            tool_names = list(settings.tools.keys())
        else:
            for extra in ("list_skills", "load_skill"):
                if extra in settings.tools and extra not in tool_names:
                    tool_names.append(extra)
        return {
            "agents": [
                {
                    "name": "fast",
                    "displayName": "Fast",
                    "description": "General assistant optimized for speed (Gemini Flash).",
                    "tools": tool_names,
                    "subagents": [],
                },
                {
                    "name": "pro",
                    "displayName": "Pro",
                    "description": "General assistant optimized for quality (Gemini Pro).",
                    "tools": tool_names,
                    "subagents": [],
                },
            ],
            "mcpServers": describe_mcp_servers(settings),
        }

    def _prepare_payload(message: ChatRequest) -> List[Dict[str, Any]]:
        return message.history or [{"role": "user", "content": message.message}]

    def _extract_request_context(request: Request) -> Dict[str, Any]:
        """Extract backend-provided context (RBAC policy, user id) from JWT."""
        if not agent_jwt_secret:
            return {}
        raw_auth = request.headers.get("authorization") or ""
        token = ""
        if raw_auth.lower().startswith("bearer "):
            token = raw_auth.split(" ", 1)[1].strip()
        if not token:
            return {}
        payload = decode_and_verify_hs256_jwt(token, agent_jwt_secret)
        if not payload:
            return {}
        context: Dict[str, Any] = {}
        user_id = payload.get("userId") or payload.get("sub")
        if isinstance(user_id, str) and user_id.strip():
            context["user_id"] = user_id.strip()
        allow_ids = payload.get("mcpServerAllowIds") or []
        deny_ids = payload.get("mcpServerDenyIds") or []
        is_admin = bool(payload.get("isAdmin", False))
        if isinstance(allow_ids, list) or isinstance(deny_ids, list) or isinstance(is_admin, bool):
            context["mcp_policy"] = {
                "allowIds": [str(x) for x in (allow_ids or []) if str(x).strip()],
                "denyIds": [str(x) for x in (deny_ids or []) if str(x).strip()],
                "isAdmin": is_admin,
            }
        return context


    def _extract_tagged_files(content: str) -> List[str]:
        if not content:
            return []
        lines = content.splitlines()
        tagged: List[str] = []
        in_block = False
        for line in lines:
            stripped = line.strip()
            if not stripped:
                if in_block:
                    break
                continue
            if stripped.startswith("Tagged files"):
                in_block = True
                continue
            if in_block:
                if stripped.startswith("-"):
                    candidate = stripped.lstrip("-").strip()
                    if candidate:
                        tagged.append(candidate)
                else:
                    break
        return tagged

    def _load_mineru_text(workspace_id: str, tagged_paths: List[str]) -> str | None:
        output_root = rag_worker.store.config.raganything_output_dir
        for raw in tagged_paths:
            if not raw:
                continue
            name = Path(raw).name
            base = name
            if base.lower().endswith(".pdf"):
                base = base[:-4]
            md_path = output_root / workspace_id / base / "auto" / f"{base}.md"
            if not md_path.exists():
                continue
            try:
                text = md_path.read_text(encoding="utf-8", errors="replace").strip()
            except Exception:
                logger.exception("Failed reading MinerU markdown: %s", md_path)
                continue
            if text:
                return text
        return None

    async def _prefetch_rag_context(workspace_id: str, prompt: str) -> str | None:
        # Use extraction rather than relying on an exact marker string so backend text can evolve.
        if not prompt:
            return None
        tagged_paths = _extract_tagged_files(prompt)
        if not tagged_paths:
            return None
        try:
            response = await rag_worker.store.query_data(
                workspace_id,
                prompt,
                mode="naive",
                include_references=False,
            )
            data = response.get("data") if isinstance(response, dict) else None
            chunks = data.get("chunks", []) if isinstance(data, dict) else []
            lines: List[str] = []
            for chunk in chunks:
                content = chunk.get("content") or ""
                if content and content.lstrip().startswith("SOURCE:"):
                    lines.append(content)
            if not lines:
                for chunk in chunks:
                    content = (chunk.get("content") or "").strip()
                    if not content:
                        continue
                    lines.append(content)
            if lines:
                non_textual = 0
                for content in lines:
                    lowered = content.lower()
                    if lowered.startswith("table analysis:") or lowered.startswith("discarded content analysis:"):
                        non_textual += 1
                if non_textual < len(lines):
                    return "\n\n".join(lines)
            response = await rag_worker.store.query_data(
                workspace_id,
                prompt,
                mode="hybrid",
                include_references=False,
            )
            data = response.get("data") if isinstance(response, dict) else None
            chunks = data.get("chunks", []) if isinstance(data, dict) else []
            lines = []
            for chunk in chunks:
                content = (chunk.get("content") or "").strip()
                if not content:
                    continue
                lines.append(content)
            if lines:
                non_textual = 0
                for content in lines:
                    lowered = content.lower()
                    if lowered.startswith("table analysis:") or lowered.startswith("discarded content analysis:"):
                        non_textual += 1
                if non_textual < len(lines):
                    return "\n\n".join(lines)
            tagged_paths = _extract_tagged_files(prompt)
            mineru_text = _load_mineru_text(workspace_id, tagged_paths)
            if mineru_text:
                return mineru_text[:12000]
            return None
        except Exception:
            logger.exception("Failed to prefetch RAG context for tagged files.")
            return None

    def _get_thread_id(runtime: AgentRuntimeState, force_reset: bool) -> str:
        context = runtime.workspace_state.context
        if force_reset or not context.get("thread_id"):
            suffix = ""
            if isinstance(context, dict):
                user_id = context.get("user_id")
                if isinstance(user_id, str) and user_id.strip():
                    suffix = f":{user_id.strip()}"
            base = f"{runtime.agent_name}:{runtime.workspace_state.workspace_id}{suffix}"
            if force_reset:
                thread_id = f"{base}:{uuid4()}"
            else:
                thread_id = base
            context["thread_id"] = thread_id
        return context["thread_id"]

    def _build_agent_config(runtime: AgentRuntimeState, message: ChatRequest, callbacks=None) -> Dict[str, Any]:
        thread_id = _get_thread_id(runtime, message.forceReset)
        config: Dict[str, Any] = {"configurable": {"thread_id": thread_id}}
        if callbacks:
            config["callbacks"] = callbacks
        return config

    def _invoke_agent(runtime: AgentRuntimeState, message: ChatRequest):
        agent = getattr(runtime, "agent", None)
        if agent is None:
            raise HTTPException(status_code=500, detail="Agent not initialized")
        context = getattr(runtime.workspace_state, "context", None)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()
        payload = _prepare_payload(message)
        config = _build_agent_config(runtime, message)
        return agent.invoke({"messages": payload}, config=config)

    def _json_line(payload: Dict[str, Any]) -> bytes:
        return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")

    def _message_to_text(message: Any) -> str:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: List[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict):
                    if isinstance(part.get("text"), str):
                        parts.append(part["text"])
                    elif "content" in part:
                        parts.append(str(part["content"]))
                elif hasattr(part, "text"):
                    parts.append(str(part.text))
            if parts:
                return "".join(parts)
        if isinstance(message, dict):
            if isinstance(message.get("content"), str):
                return message["content"]
            if "text" in message and isinstance(message["text"], str):
                return message["text"]
        if hasattr(message, "text"):
            return str(message.text)
        return str(message)

    class _CallbackStreamingHandler(AsyncCallbackHandler):
        """Streams LangChain callback events into JSON payloads for the UI."""

        def __init__(self, text_fn):
            super().__init__()
            self.queue: asyncio.Queue[Any] = asyncio.Queue()
            self._tool_names: Dict[str, str] = {}
            self._tool_meta: Dict[str, Any] = {}
            self._active_llm_runs: Set[str] = set()
            self._to_text = text_fn
            self._has_events = False
            self._has_assistant_text = False

        @property
        def has_events(self) -> bool:
            return self._has_events

        @property
        def has_assistant_text(self) -> bool:
            return self._has_assistant_text

        async def _emit(self, payload: Dict[str, Any]) -> None:
            self._has_events = True
            if payload.get("type") in {"token", "chunk"}:
                role = payload.get("role")
                if role is None or str(role).lower() == "assistant":
                    self._has_assistant_text = True
            await self.queue.put(payload)

        async def on_llm_new_token(
            self,
            token: str,
            *,
            run_id,
            **_: Any,
        ) -> None:
            if not token:
                return
            self._active_llm_runs.add(str(run_id))
            await self._emit({"type": "token", "content": token, "role": "assistant"})

        async def on_llm_end(self, response, *, run_id, **_: Any) -> None:
            run_key = str(run_id)
            if run_key in self._active_llm_runs:
                self._active_llm_runs.discard(run_key)
                return
            generations = getattr(response, "generations", None)
            if not generations:
                return
            text_parts: List[str] = []
            for generation in generations:
                if not generation:
                    continue
                candidate = generation[0]
                candidate_text = getattr(candidate, "text", None)
                if candidate_text:
                    text_parts.append(candidate_text)
            if text_parts:
                await self._emit(
                    {"type": "token", "content": "".join(text_parts), "role": "assistant"}
                )

        async def on_agent_action(self, action, **_: Any) -> None:
            log = getattr(action, "log", "")
            if log:
                await self._emit({"type": "thought", "content": log})

        async def on_agent_finish(self, finish, **_: Any) -> None:
            if self._has_assistant_text:
                return
            text = ""
            return_values = getattr(finish, "return_values", None)
            if isinstance(return_values, dict):
                candidate = return_values.get("output") or return_values.get("text")
                if isinstance(candidate, str):
                    text = candidate
            if not text:
                text = self._to_text(finish)
            if text:
                for piece in _chunk_text(text):
                    await self._emit({"type": "token", "content": piece, "role": "assistant"})

        async def on_tool_start(
            self,
            serialized,
            input_str,
            *,
            run_id,
            metadata: Dict[str, Any] | None = None,
            **_: Any,
        ) -> None:
            name = (serialized or {}).get("name") or (metadata or {}).get("name") or "tool"
            self._tool_names[str(run_id)] = name
            preview = input_str.strip()
            await self._emit(
                {
                    "type": "tool_start",
                    "name": name,
                    "content": preview[:200] if preview else "",
                }
            )

        async def on_tool_end(self, output, *, run_id, **_: Any) -> None:
            run_key = str(run_id)
            name = self._tool_names.pop(run_key, "tool")
            text = self._to_text(output)
            payload: Dict[str, Any] = {
                "type": "tool_end",
                "name": name,
                "content": text,
            }
            output_files = _extract_output_files_from_tool_result(name, text)
            meta = self._tool_meta.pop(run_key, None)
            if meta and meta.get("files"):
                output_files.extend(meta["files"])
            if output_files:
                dedup: Dict[str, Dict[str, Any]] = {}
                for item in output_files:
                    path = str(item.get("path") or "").strip()
                    if not path:
                        continue
                    dedup[path] = item
                payload["outputFiles"] = list(dedup.values())
            await self._emit(payload)

        async def on_tool_error(self, error, *, run_id, **_: Any) -> None:
            name = self._tool_names.pop(str(run_id), "tool")
            await self._emit(
                {
                    "type": "tool_error",
                    "name": name,
                    "content": str(error),
                }
            )

        async def on_custom_event(
            self,
            name: str,
            data: Any,
            *,
            run_id,
            **_: Any,
        ) -> None:
            if name == "tool_artifacts" and isinstance(data, dict):
                self._tool_meta[str(run_id)] = data

    class _DeltaTracker:
        def __init__(self) -> None:
            self._latest: Dict[str, str] = {}

        def push(self, role: str, text: str) -> str:
            if not text:
                return ""
            previous = self._latest.get(role, "")
            if text.startswith(previous):
                delta = text[len(previous):]
            else:
                delta = text
            self._latest[role] = text
            return delta

    def _chunk_text(payload: str, max_chars: int = 60) -> Iterable[str]:
        if len(payload) <= max_chars:
            return [payload]

        chunks: List[str] = []
        start = 0
        text_length = len(payload)
        while start < text_length:
            end = min(text_length, start + max_chars)
            if end < text_length:
                newline = payload.rfind("\n", start, end)
                if newline > start + 40:
                    end = newline + 1
            chunk = payload[start:end]
            if chunk:
                chunks.append(chunk)
            start = max(end, start + 1)
        return chunks

    def _message_role(message: Any) -> str:
        for attr in ("type", "role"):
            value = getattr(message, attr, None)
            if isinstance(value, str):
                return value.lower()
            if isinstance(value, dict):
                role = value.get("role")
                if isinstance(role, str):
                    return role.lower()
        if isinstance(message, dict):
            role = message.get("role")
            if isinstance(role, str):
                return role.lower()
        return "assistant"

    def _parse_multi_mode_chunk(raw_chunk: Any) -> tuple[str | None, Any]:
        if isinstance(raw_chunk, tuple) and len(raw_chunk) == 2 and isinstance(raw_chunk[0], str):
            return raw_chunk[0], raw_chunk[1]
        return None, raw_chunk

    def _extract_messages(chunk: Any) -> List[Any] | None:
        if chunk is None:
            return None
        if isinstance(chunk, dict):
            if "messages" in chunk:
                return chunk.get("messages")  # type: ignore[return-value]
            output = chunk.get("output")
            if isinstance(output, dict) and "messages" in output:
                return output.get("messages")  # type: ignore[return-value]
        if isinstance(chunk, (list, tuple)):
            if len(chunk) == 2 and chunk[0] == "messages":
                candidate = chunk[1]
                if isinstance(candidate, (list, tuple)):
                    return list(candidate)
                if candidate is not None:
                    return [candidate]
                return None
            for item in chunk:
                if isinstance(item, dict) and "messages" in item:
                    return item.get("messages")  # type: ignore[return-value]
        return None

    def _extract_interrupt_payload(chunk: Any) -> Dict[str, Any] | None:
        if not isinstance(chunk, dict):
            return None
        raw = chunk.get("__interrupt__")
        if not raw or not isinstance(raw, list):
            return None
        first = raw[0] if raw else None
        if first is None:
            return None

        interrupt_value = None
        interrupt_id = None
        if isinstance(first, dict):
            interrupt_value = first.get("value")
            interrupt_id = first.get("id")
        else:
            interrupt_value = getattr(first, "value", None)
            interrupt_id = getattr(first, "id", None)

        if not isinstance(interrupt_value, dict):
            return None

        action_requests = interrupt_value.get("action_requests")
        review_configs = interrupt_value.get("review_configs")
        payload = {
            "type": "interrupt",
            "actionRequests": action_requests if isinstance(action_requests, list) else [],
            "reviewConfigs": review_configs if isinstance(review_configs, list) else [],
        }
        if isinstance(interrupt_id, str) and interrupt_id:
            payload["interruptId"] = interrupt_id
        return payload

    def _active_skill_policy(runtime: AgentRuntimeState) -> Dict[str, Any]:
        context = runtime.workspace_state.context or {}
        raw_policy = context.get("active_skill_policy") or {}
        if not isinstance(raw_policy, dict):
            raw_policy = {}
        raw_limit = raw_policy.get("pre_plan_search_limit", 0)
        raw_used = context.get("pre_plan_search_count", 0)
        try:
            pre_plan_search_limit = max(0, int(raw_limit or 0))
        except (TypeError, ValueError):
            pre_plan_search_limit = 0
        try:
            pre_plan_search_used = max(0, int(raw_used or 0))
        except (TypeError, ValueError):
            pre_plan_search_used = 0
        return {
            "skill": context.get("active_skill"),
            "requiresHitlPlan": bool(raw_policy.get("requires_hitl_plan", False)),
            "requiresArtifacts": bool(raw_policy.get("requires_workspace_artifacts", False)),
            "requiredArtifactsMode": raw_policy.get("required_artifacts_mode"),
            "prePlanSearchLimit": pre_plan_search_limit,
            "prePlanSearchUsed": pre_plan_search_used,
        }

    def _missing_required_artifacts(runtime: AgentRuntimeState) -> List[str]:
        context = runtime.workspace_state.context or {}
        policy = context.get("active_skill_policy") or {}
        if not isinstance(policy, dict):
            return []
        if not bool(policy.get("requires_workspace_artifacts", False)):
            return []
        mode = str(policy.get("required_artifacts_mode") or "").strip().lower()
        if mode != "full_pack":
            return []

        root = runtime.workspace_state.root_path
        required = policy.get("required_artifacts") or []
        required_items = [str(item).strip() for item in required if str(item).strip()]
        missing: List[str] = []
        for item in required_items:
            if item.startswith("pattern:"):
                pattern = item[len("pattern:"):].lstrip("/")
                matched = False
                for child in root.rglob("*"):
                    if not child.is_file():
                        continue
                    rel = child.relative_to(root).as_posix()
                    if fnmatch.fnmatch(rel, pattern):
                        matched = True
                        break
                if not matched:
                    missing.append(item)
                continue
            rel = item.lstrip("/")
            if not (root / rel).exists():
                missing.append(item)
        return missing

    _ASSISTANT_ROLES = {"assistant", "ai", "aimessagechunk"}
    _TOOL_ROLES = {"tool"}

    def _emit_text(role: str, text: str) -> Iterable[Dict[str, str]]:
        if not text:
            return []
        if role in _ASSISTANT_ROLES:
            return [
                {"type": "token", "content": piece, "role": "assistant"}
                for piece in _chunk_text(text)
            ]
        if role in _TOOL_ROLES:
            return [
                {"type": "thought", "content": text, "role": role}
            ]
        return []

    async def _stream_agent_response(
        runtime: AgentRuntimeState,
        message: ChatRequest,
        *,
        resume_decisions: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[bytes, None]:
        agent = getattr(runtime, "agent", None)
        if agent is None:
            yield _json_line({"type": "error", "message": "Agent not initialized"})
            return
        context = getattr(runtime.workspace_state, "context", None)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()

        payload = _prepare_payload(message)
        if not resume_decisions:
            tagged_files = _extract_tagged_files(message.message)
            runtime.workspace_state.context["tagged_files"] = tagged_files
            # Historical behavior forced "RAG-only" when any tagged files were present, which breaks
            # when those files aren't indexed yet (e.g., agent-generated artifacts) and blocks basic
            # file tools. Keep it behind an env flag for compatibility.
            tagged_files_rag_only = (os.getenv("TAGGED_FILES_RAG_ONLY", "false") or "false").strip().lower() in {
                "1",
                "true",
                "yes",
                "y",
                "on",
            }
            runtime.workspace_state.context["tagged_files_only"] = bool(tagged_files) and tagged_files_rag_only
            if tagged_files:
                rag_context = await _prefetch_rag_context(runtime.workspace_state.workspace_id, message.message)
                if rag_context:
                    runtime.workspace_state.context["tagged_rag_context"] = rag_context
                    if tagged_files_rag_only:
                        payload = [{"role": "user", "content": f"{message.message}\n\nRAG_CONTEXT:\n{rag_context}\n\nAnswer using only RAG_CONTEXT."}]
        handler = _CallbackStreamingHandler(_message_to_text)
        sentinel = object()
        stream_started = asyncio.get_running_loop().time()
        saw_interrupt = False
        yield _json_line({"type": "policy", **_active_skill_policy(runtime)})
        logger.info(
            "Agent stream start: agent=%s workspace=%s",
            runtime.agent_name,
            runtime.workspace_state.workspace_id,
        )

        async def _agent_runner():
            try:
                nonlocal saw_interrupt
                stream_config = _build_agent_config(runtime, message, callbacks=[handler])
                stream_input: Any = {"messages": payload}
                if resume_decisions:
                    stream_input = Command(resume={"decisions": resume_decisions})
                final_result = await agent.ainvoke(stream_input, config=stream_config)

                emitted = False
                interrupt_payload = _extract_interrupt_payload(final_result)
                if interrupt_payload:
                    saw_interrupt = True
                    emitted = True
                    await handler._emit(interrupt_payload)

                messages = _extract_messages(final_result)
                if messages and not handler.has_assistant_text:
                    tracker = _DeltaTracker()
                    for msg in messages:
                        text = _message_to_text(msg)
                        role = _message_role(msg)
                        delta = tracker.push(role, text)
                        if delta:
                            emitted = True
                            for event_payload in _emit_text(role, delta):
                                await handler._emit(event_payload)
                elif not handler.has_assistant_text:
                    text = _message_to_text(final_result)
                    if text:
                        emitted = True
                        for event_payload in _emit_text("assistant", text):
                            await handler._emit(event_payload)

                if not emitted and not handler.has_events:
                    await handler._emit(
                        {
                            "type": "thought",
                            "role": "assistant",
                            "content": "Model returned no output",
                        }
                    )
            except Exception as exc:  # pragma: no cover - streaming guard
                await handler._emit({"type": "error", "message": str(exc)})
                raise
            finally:
                elapsed = asyncio.get_running_loop().time() - stream_started
                logger.info(
                    "Agent stream finished: agent=%s workspace=%s elapsed=%.2fs",
                    runtime.agent_name,
                    runtime.workspace_state.workspace_id,
                    elapsed,
                )
                await handler.queue.put(sentinel)

        task = asyncio.create_task(_agent_runner())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(handler.queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield _json_line({"type": "keepalive"})
                    continue
                if event is sentinel:
                    break
                yield _json_line(event)
            source_tracker.update_final_report(runtime.workspace_state)
            if not saw_interrupt:
                missing = _missing_required_artifacts(runtime)
                if missing:
                    runtime.workspace_state.context["artifact_contract_failed"] = True
                    yield _json_line(
                        {
                            "type": "contract_error",
                            "message": "Artifact contract not satisfied.",
                            "missing": missing,
                        }
                    )
            yield _json_line({"type": "done"})
        finally:
            await task

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat", response_model=ChatResponse)
    async def chat(agent_name: str, workspace_id: str, chat_request: ChatRequest, request: Request):
        try:
            initial_context = _extract_request_context(request)
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        tagged_files = _extract_tagged_files(chat_request.message)
        runtime.workspace_state.context["tagged_files"] = tagged_files
        tagged_files_rag_only = (os.getenv("TAGGED_FILES_RAG_ONLY", "false") or "false").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
            "on",
        }
        runtime.workspace_state.context["tagged_files_only"] = bool(tagged_files) and tagged_files_rag_only
        if tagged_files:
            rag_context = await _prefetch_rag_context(runtime.workspace_state.workspace_id, chat_request.message)
            if rag_context:
                runtime.workspace_state.context["tagged_rag_context"] = rag_context
                if tagged_files_rag_only:
                    chat_request = ChatRequest(
                        message=f"{chat_request.message}\n\nRAG_CONTEXT:\n{rag_context}\n\nAnswer using only RAG_CONTEXT.",
                        history=chat_request.history,
                        forceReset=chat_request.forceReset,
                    )

        result = _invoke_agent(runtime, chat_request)
        source_tracker.update_final_report(runtime.workspace_state)
        return ChatResponse(reply=result)

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream")
    async def chat_stream(agent_name: str, workspace_id: str, chat_request: ChatRequest, request: Request):
        try:
            initial_context = _extract_request_context(request)
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        stream = _stream_agent_response(runtime, chat_request)
        return StreamingResponse(stream, media_type="application/jsonl")

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream/resume")
    async def chat_stream_resume(
        agent_name: str,
        workspace_id: str,
        resume_request: ResumeChatRequest,
        request: Request,
    ):
        try:
            initial_context = _extract_request_context(request)
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        decisions_payload: List[Dict[str, Any]] = []
        for item in resume_request.decisions:
            if hasattr(item, "model_dump"):
                decisions_payload.append(item.model_dump(exclude_none=True))  # type: ignore[attr-defined]
            else:
                decisions_payload.append(item.dict(exclude_none=True))  # type: ignore[attr-defined]
        placeholder = ChatRequest(message="", history=None, forceReset=False)
        stream = _stream_agent_response(runtime, placeholder, resume_decisions=decisions_payload)
        return StreamingResponse(stream, media_type="application/jsonl")

    return app
