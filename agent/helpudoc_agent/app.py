"""FastAPI surface for the DeepAgents service."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, AsyncGenerator, Iterable, Sequence, Set
import json
import logging
from pathlib import Path
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .configuration import load_settings
from .graph import AgentRegistry
from .prompts import PromptStore
from .state import AgentRuntimeState
from .tools_and_schemas import ToolFactory, GeminiClientManager, MCPServerRegistry
from .utils import SourceTracker
from langchain_core.callbacks.base import AsyncCallbackHandler


logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False


class ChatResponse(BaseModel):
    reply: Any


BASE_DIR = Path(__file__).resolve().parent


def _load_env_files() -> None:
    """Load environment variables from known locations.

    We prioritize the agent's .env (agent/.env) and then allow any existing
    process-level env vars to remain.
    """
    load_dotenv(BASE_DIR.parent / ".env")


def create_app() -> FastAPI:
    _load_env_files()
    settings = load_settings()
    prompt_store = PromptStore()
    source_tracker = SourceTracker()
    gemini_manager = GeminiClientManager(settings)
    tool_factory = ToolFactory(settings, source_tracker, gemini_manager)
    registry = AgentRegistry(settings, prompt_store, tool_factory)
    mcp_registry = MCPServerRegistry(settings)

    app = FastAPI(title="DeepAgents Service", version="0.2.0")

    @app.get("/agents")
    def list_agents():
        return {
            "agents": [
                {
                    "name": agent.name,
                    "displayName": agent.display_name,
                    "description": agent.description,
                    "tools": agent.tools,
                    "subagents": [
                        {
                            "name": sub.name,
                            "description": sub.description,
                            "tools": sub.tools,
                        }
                        for sub in agent.subagents
                    ],
                }
                for agent in settings.list_agents()
            ],
            "mcpServers": mcp_registry.describe(),
        }

    def _prepare_payload(message: ChatRequest) -> List[Dict[str, Any]]:
        return message.history or [{"role": "user", "content": message.message}]

    def _invoke_agent(runtime: AgentRuntimeState, message: ChatRequest):
        agent = getattr(runtime, "agent", None)
        if agent is None:
            raise HTTPException(status_code=500, detail="Agent not initialized")
        context = getattr(runtime.workspace_state, "context", None)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()
        payload = _prepare_payload(message)
        return agent.invoke({"messages": payload})

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

        @property
        def has_events(self) -> bool:
            return self._has_events

        async def _emit(self, payload: Dict[str, Any]) -> None:
            self._has_events = True
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
            meta = self._tool_meta.pop(run_key, None)
            if meta and meta.get("files"):
                payload["outputFiles"] = meta["files"]
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

    async def _stream_agent_response(runtime: AgentRuntimeState, message: ChatRequest) -> AsyncGenerator[bytes, None]:
        agent = getattr(runtime, "agent", None)
        if agent is None:
            yield _json_line({"type": "error", "message": "Agent not initialized"})
            return
        context = getattr(runtime.workspace_state, "context", None)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()

        payload = _prepare_payload(message)
        handler = _CallbackStreamingHandler(_message_to_text)
        sentinel = object()
        fallback_chunks: List[Any] = []

        async def _agent_runner():
            try:
                async for raw_chunk in agent.astream({"messages": payload}, config={"callbacks": [handler]}):
                    fallback_chunks.append(raw_chunk)
            except ValueError as exc:
                message_text = str(exc)
                if "No generations found in stream" in message_text:
                    logger.warning(
                        "Model for agent '%s' workspace '%s' does not support streaming; falling back to sync response",
                        runtime.agent_name,
                        runtime.workspace_state.workspace_id,
                    )
                    try:
                        fallback_result = _invoke_agent(runtime, message)
                    except Exception as inner_exc:  # pragma: no cover - defensive
                        logger.exception(
                            "Fallback invoke failed for agent '%s' in workspace '%s'",
                            runtime.agent_name,
                            runtime.workspace_state.workspace_id,
                        )
                        await handler.queue.put({"type": "error", "message": str(inner_exc)})
                        raise
                    emitted = False
                    messages = _extract_messages(fallback_result)
                    if messages:
                        tracker = _DeltaTracker()
                        for msg in messages:
                            text = _message_to_text(msg)
                            role = _message_role(msg)
                            delta = tracker.push(role, text)
                            if delta:
                                emitted = True
                                for event_payload in _emit_text(role, delta):
                                    await handler._emit(event_payload)
                    else:
                        text = _message_to_text(fallback_result)
                        if text:
                            emitted = True
                            for event_payload in _emit_text("assistant", text):
                                await handler._emit(event_payload)
                    if not emitted:
                        await handler._emit({"type": "thought", "role": "assistant", "content": "Model returned no output"})
                    return
                await handler._emit({"type": "error", "message": message_text})
                raise
            except Exception as exc:  # pragma: no cover - streaming guard
                await handler._emit({"type": "error", "message": str(exc)})
                raise
            finally:
                if not handler.has_events and fallback_chunks:
                    tracker = _DeltaTracker()
                    for raw_chunk in fallback_chunks:
                        mode, chunk = _parse_multi_mode_chunk(raw_chunk)
                        if mode == "messages":
                            message_chunk = chunk
                            if isinstance(chunk, (list, tuple)) and len(chunk) == 2:
                                message_chunk = chunk[0]
                            text = _message_to_text(message_chunk)
                            role = _message_role(message_chunk)
                            delta = tracker.push(role, text)
                            if delta:
                                for event_payload in _emit_text(role, delta):
                                    await handler._emit(event_payload)
                            continue

                        messages = _extract_messages(chunk)
                        if not messages:
                            continue
                        last_message = messages[-1]
                        text = _message_to_text(last_message)
                        role = _message_role(last_message)
                        delta = tracker.push(role, text)
                        if delta:
                            for event_payload in _emit_text(role, delta):
                                await handler._emit(event_payload)
                await handler.queue.put(sentinel)

        task = asyncio.create_task(_agent_runner())
        try:
            while True:
                event = await handler.queue.get()
                if event is sentinel:
                    break
                yield _json_line(event)
            source_tracker.update_final_report(runtime.workspace_state)
            yield _json_line({"type": "done"})
        finally:
            await task

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat", response_model=ChatResponse)
    async def chat(agent_name: str, workspace_id: str, chat_request: ChatRequest):
        try:
            runtime = registry.get_or_create(agent_name, workspace_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        result = _invoke_agent(runtime, chat_request)
        source_tracker.update_final_report(runtime.workspace_state)
        return ChatResponse(reply=result)

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream")
    async def chat_stream(agent_name: str, workspace_id: str, chat_request: ChatRequest):
        try:
            runtime = registry.get_or_create(agent_name, workspace_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        stream = _stream_agent_response(runtime, chat_request)
        return StreamingResponse(stream, media_type="application/jsonl")

    return app
