"""FastAPI surface for the DeepAgents service."""
from __future__ import annotations

from typing import Any, Dict, List, AsyncGenerator, Iterable, Sequence
import json
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .configuration import load_settings
from .graph import AgentRegistry
from .prompts import PromptStore
from .state import AgentRuntimeState
from .tools_and_schemas import ToolFactory, GeminiClientManager, MCPServerRegistry
from .utils import SourceTracker


logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False


class ChatResponse(BaseModel):
    reply: Any


def create_app() -> FastAPI:
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
        payload = _prepare_payload(message)
        return agent.invoke({"messages": payload})

    def _json_line(payload: Dict[str, Any]) -> bytes:
        return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")

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
        """Split long deltas into smaller pieces so the UI renders smoother."""
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

        payload = _prepare_payload(message)
        tracker = _DeltaTracker()
        try:
            async for raw_chunk in agent.astream({"messages": payload}, stream_mode=["values", "messages"]):
                mode, chunk = _parse_multi_mode_chunk(raw_chunk)
                if mode == "messages":
                    message_chunk = chunk
                    if isinstance(chunk, (list, tuple)) and len(chunk) == 2:
                        message_chunk = chunk[0]
                    text = _message_to_text(message_chunk)
                    role = _message_role(message_chunk)
                    for payload in _emit_text(role, text):
                        yield _json_line(payload)
                    continue

                messages = _extract_messages(chunk)
                if not messages:
                    continue
                last_message = messages[-1]
                text = _message_to_text(last_message)
                role = _message_role(last_message)
                delta = tracker.push(role, text)
                if delta:
                    for payload in _emit_text(role, delta):
                        yield _json_line(payload)
            source_tracker.update_final_report(runtime.workspace_state)
            yield _json_line({"type": "done"})
        except ValueError as exc:
            message_text = str(exc)
            if "No generations found in stream" not in message_text:
                logger.exception(
                    "Streaming error for agent '%s' in workspace '%s'",
                    runtime.agent_name,
                    runtime.workspace_state.workspace_id,
                )
                yield _json_line({"type": "error", "message": message_text})
                raise

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
                yield _json_line({"type": "error", "message": str(inner_exc)})
                raise

            streamed = False
            messages = _extract_messages(fallback_result)
            if messages:
                for msg in messages:
                    text = _message_to_text(msg)
                    role = _message_role(msg)
                    for payload in _emit_text(role, text):
                        streamed = True
                        yield _json_line(payload)
            else:
                text = _message_to_text(fallback_result)
                if text:
                    streamed = True
                    for payload in _emit_text("assistant", text):
                        yield _json_line(payload)

            if not streamed:
                yield _json_line({"type": "thought", "role": "assistant", "content": "Model returned no output"})

            source_tracker.update_final_report(runtime.workspace_state)
            yield _json_line({"type": "done"})
        except Exception as exc:
            logger.exception(
                "Streaming error for agent '%s' in workspace '%s'",
                runtime.agent_name,
                runtime.workspace_state.workspace_id,
            )
            yield _json_line({"type": "error", "message": str(exc)})
            raise

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
