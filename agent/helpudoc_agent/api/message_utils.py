"""Payload and multimodal message helpers shared by chat routes."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List


def _copy_content_block(block: Any) -> Any:
    if isinstance(block, dict):
        return dict(block)
    return block


def _extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                    continue
                if item.get("type") == "text-plain" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
                    continue
                if "content" in item and isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "\n".join(part for part in parts if part).strip()
    return str(content or "").strip()


def _replace_content_text(content: Any, text: str) -> Any:
    if isinstance(content, str):
        return text
    if isinstance(content, list):
        updated: List[Any] = []
        replaced = False
        for item in content:
            if isinstance(item, dict):
                copied = dict(item)
                block_type = str(copied.get("type") or "").strip().lower()
                if block_type in {"text", "text-plain"} or isinstance(copied.get("text"), str):
                    copied["text"] = text
                    updated.append(copied)
                    replaced = True
                    continue
                if isinstance(copied.get("content"), str):
                    copied["content"] = text
                    updated.append(copied)
                    replaced = True
                    continue
                updated.append(copied)
                continue
            updated.append(item)
        if replaced:
            return updated
        return [{"type": "text", "text": text}, *updated]
    return text


def _host_datetime_context_block() -> str:
    """Wall-clock snapshot for the model; agent system prompts are cached and omit real time."""
    utc_now = datetime.now(timezone.utc)
    local_now = datetime.now().astimezone()
    local_tz_name = local_now.tzname() or "local"
    return (
        "[Host time]\n"
        "Use this block as the authoritative current date/time for this turn. "
        "If the user says \"today\", \"tomorrow\", \"this week\", a calendar year, a deadline, or asks for a dated filename, "
        "use these timestamps instead of model priors.\n"
        f"Authoritative local date: {local_now.date().isoformat()}\n"
        f"UTC: {utc_now.isoformat(timespec='seconds')}\n"
        f"Server local ({local_tz_name}): {local_now.isoformat(timespec='seconds')}"
    )


def _inject_host_datetime_context(payload: List[Dict[str, Any]]) -> None:
    """Inject a fresh host-time system message and also prefix the latest user message for extra salience."""
    block = _host_datetime_context_block()
    payload.insert(0, {"role": "system", "content": block})
    for index in range(len(payload) - 1, -1, -1):
        role = str(payload[index].get("role") or "").strip().lower()
        if role not in {"user", "human"}:
            continue
        content = payload[index].get("content")
        if isinstance(content, str):
            stripped = content.strip()
            payload[index]["content"] = f"{block}\n\n{stripped}" if stripped else block
        elif isinstance(content, list):
            payload[index]["content"] = [{"type": "text", "text": block}, *content]
        else:
            text = str(content or "").strip()
            payload[index]["content"] = f"{block}\n\n{text}" if text else block
        return


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
