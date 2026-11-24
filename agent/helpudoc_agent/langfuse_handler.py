"""Langfuse handler that records each piece of a run once.

The stock CallbackHandler stores the whole graph state on every chain span. Each model
step runs six of those (middleware hooks and the model wrapper), so one step stored the
conversation seven times, attachments included: 19 GB of raw events in two weeks in
production, which filled MinIO and stopped user uploads.

What is kept, so a trace still shows exactly what happened:

- Model calls: the full prompt and reply.
- Tool calls: the full input and output.
- Nested chain spans: name, timing, errors and a short digest. Their state is the same
  conversation that the model calls around them already hold.
- The trace and its root span: the user's message and the final answer. FastAPI's request
  span is the OpenTelemetry root and has neither, so Langfuse listed every trace as empty.

File content (base64) is replaced by its name, type, size and SHA-256. The file itself is
kept as an immutable workspace version. Redaction works on copies: the messages passed to
a callback are the ones the model receives.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import re
from dataclasses import replace
from typing import Any, Dict, Optional

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langfuse.langchain import CallbackHandler
from langgraph.types import Command

logger = logging.getLogger(__name__)

# Shorter values are not worth replacing.
_MIN_BASE64_CHARS = 200
# A nested chain's own (non-message) output is kept up to this size.
_MAX_SMALL_VALUE_CHARS = 2000
_MIME_KEYS = ("mime_type", "mimeType", "media_type")
_DATA_URL_RE = re.compile(r"data:([\w.+-]+/[\w.+-]+);base64,([A-Za-z0-9+/_=-]{%d,})" % _MIN_BASE64_CHARS)


def _fingerprint(data: Any) -> Dict[str, Any]:
    if isinstance(data, str):
        try:
            data = base64.b64decode(data, altchars=b"-_" if ("-" in data or "_" in data) else None)
        except (binascii.Error, ValueError):
            data = data.encode("utf-8", "replace")
    return {"size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def _data_url_note(match: re.Match[str]) -> str:
    info = _fingerprint(match.group(2))
    return f"[file omitted from trace: {match.group(1)}, {info['size_bytes']} bytes, sha256 {info['sha256']}]"


def redact_files(value: Any) -> Any:
    """A copy of value with file content replaced by a fingerprint. Text is unchanged."""
    if isinstance(value, str):
        return _DATA_URL_RE.sub(_data_url_note, value) if ";base64," in value else value
    if isinstance(value, BaseMessage):
        return value.model_copy(update={"content": redact_files(value.content)})
    if isinstance(value, Command):
        return replace(value, update=redact_files(value.update))
    if isinstance(value, dict):
        has_mime = any(isinstance(value.get(key), str) for key in _MIME_KEYS)
        out: Dict[Any, Any] = {}
        for key, item in value.items():
            is_file = (key == "base64" or (key == "data" and has_mime)) and isinstance(item, (str, bytes))
            if is_file and len(item) >= _MIN_BASE64_CHARS:
                out["omitted_from_trace"] = _fingerprint(item)
            else:
                out[key] = redact_files(item)
        return out
    if isinstance(value, list):
        return [redact_files(item) for item in value]
    if isinstance(value, tuple) and type(value) is tuple:
        return tuple(redact_files(item) for item in value)
    return value


def _digest(value: Any) -> Any:
    """What a nested chain handled, without copying the conversation."""
    if value is None:
        return None
    if isinstance(value, Command):
        return {"command": _digest(value.update), "goto": str(value.goto)[:200] if value.goto else None}
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(item, (list, tuple)):
                out[f"{key}_count"] = len(item)
            elif isinstance(item, dict):
                out[f"{key}_keys"] = len(item)
            elif isinstance(item, (str, int, float, bool)) or item is None:
                out[str(key)] = item[:_MAX_SMALL_VALUE_CHARS] if isinstance(item, str) else item
            else:
                out[str(key)] = type(item).__name__
        return out
    if isinstance(value, (list, tuple)):
        return {"count": len(value)}
    if isinstance(value, (str, int, float, bool)):
        return value[:_MAX_SMALL_VALUE_CHARS] if isinstance(value, str) else value
    return {"type": type(value).__name__}


def _messages_of(state: Any) -> list:
    messages = state.get("messages") if isinstance(state, dict) else getattr(state, "messages", None)
    # A graph may wrap the list (for example in Overwrite).
    messages = getattr(messages, "value", messages)
    return list(messages) if isinstance(messages, (list, tuple)) else []


def _is_user(message: Any) -> bool:
    if isinstance(message, dict):
        return message.get("role") in {"user", "human"}
    # Summaries and Lumo's own notes are HumanMessages with an lc_source.
    return isinstance(message, HumanMessage) and not message.additional_kwargs.get("lc_source")


def user_input(inputs: Any) -> Any:
    """The user's message for this run, or the answer that resumed it."""
    if isinstance(inputs, Command):
        return {"resume": redact_files(inputs.resume)}
    for message in reversed(_messages_of(inputs)):
        if _is_user(message):
            return redact_files(message.get("content") if isinstance(message, dict) else message.content)
    return _digest(inputs)


def final_output(outputs: Any) -> Any:
    """Lumo's answer, or why there is none."""
    if isinstance(outputs, dict) and outputs.get("__interrupt__"):
        return {"status": "waiting for the user"}
    messages = _messages_of(outputs)
    last = messages[-1] if messages else None
    if isinstance(last, AIMessage):
        text = last.text if isinstance(last.text, str) else last.text()
        if text.strip():
            return text
        if last.tool_calls:
            return {"status": "ended on tool calls", "tools": [call["name"] for call in last.tool_calls]}
        return {"status": "no reply"}
    if messages:
        return {"status": "no reply"}
    return _digest(outputs)


class TrimmedLangfuseHandler(CallbackHandler):
    def _update_trace(self, run_id: Any, **fields: Any) -> None:
        try:
            observation = self.runs.get(run_id)
            if observation is not None:
                observation.update_trace(**fields)
        except Exception:
            logger.debug("Langfuse trace update skipped", exc_info=True)

    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, **kwargs: Any) -> Any:
        is_root = parent_run_id is None
        recorded = self._safe(user_input if is_root else _digest, inputs)
        result = super().on_chain_start(serialized, recorded, run_id=run_id, parent_run_id=parent_run_id, **kwargs)
        if is_root:
            name = kwargs.get("name")
            self._update_trace(run_id, input=recorded, **({"name": name} if name else {}))
        return result

    def on_chain_end(self, outputs, *, run_id, parent_run_id=None, **kwargs: Any) -> Any:
        kwargs.pop("inputs", None)  # the full state again; the start already recorded it
        is_root = parent_run_id is None
        recorded = self._safe(final_output if is_root else _digest, outputs)
        if is_root:
            self._update_trace(run_id, output=recorded)
        return super().on_chain_end(recorded, run_id=run_id, parent_run_id=parent_run_id, **kwargs)

    def on_chain_error(self, error, *, run_id, parent_run_id=None, **kwargs: Any) -> None:
        kwargs.pop("inputs", None)
        if parent_run_id is None:
            kind = type(error).__name__
            if "Interrupt" in kind:
                output: Dict[str, Any] = {"status": "waiting for the user"}
            elif kind == "CancelledError":
                output = {"status": "stopped"}
            else:
                output = {"status": "failed", "error": f"{kind}: {error}"[:_MAX_SMALL_VALUE_CHARS]}
            self._update_trace(run_id, output=output)
        super().on_chain_error(error, run_id=run_id, parent_run_id=parent_run_id, **kwargs)

    def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, **kwargs: Any) -> Any:
        recorded = self._safe(redact_files, messages, fallback=[[]])
        result = super().on_chat_model_start(
            serialized, recorded, run_id=run_id, parent_run_id=parent_run_id, **kwargs
        )
        if parent_run_id is None:  # a direct model call, such as internal analysis
            name = kwargs.get("name")
            prompt = user_input({"messages": recorded[0] if recorded else []})
            self._update_trace(run_id, input=prompt, **({"name": name} if name else {}))
        return result

    def on_llm_end(self, response, *, run_id, parent_run_id=None, **kwargs: Any) -> Any:
        kwargs.pop("inputs", None)
        if parent_run_id is None:
            try:
                message = response.generations[-1][-1].message
                self._update_trace(run_id, output=final_output({"messages": [message]}))
            except Exception:
                logger.debug("Langfuse trace output skipped", exc_info=True)
        return super().on_llm_end(response, run_id=run_id, parent_run_id=parent_run_id, **kwargs)

    def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs: Any) -> Any:
        return super().on_tool_end(
            self._safe(redact_files, output), run_id=run_id, parent_run_id=parent_run_id, **kwargs
        )

    @staticmethod
    def _safe(function, value: Any, fallback: Optional[Any] = None) -> Any:
        # Tracing must never break a run, and a failed trim must not fall back to the raw value.
        try:
            return function(value)
        except Exception:
            logger.warning("Langfuse value could not be trimmed; omitted from the trace", exc_info=True)
            return fallback
