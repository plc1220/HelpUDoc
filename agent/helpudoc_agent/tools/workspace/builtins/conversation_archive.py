"""Earlier messages of the current conversation, for search within one run only.

Governance (a leak here exposes one user's chat to another, the highest-severity case):

- The backend builds the archive from the database, for the requesting user's own
  conversation, after its access checks (creator and workspace membership). It is never
  taken from the browser.
- It reaches the agent in the run request and is bound to that run's task through a
  ContextVar. It is not stored on the cached runtime (which one user's concurrent chats
  share), not written to disk, and not kept after the run.
- Tools read it through current_conversation_archive() and take no conversation, user or
  workspace argument, so the model cannot point a search at another conversation.
- Runs started without an archive (resumes, Shared Chat, schedules, Skill Builder, short
  chats) see None.
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

# Defensive caps on what the agent accepts, independent of the backend's own caps.
MAX_ARCHIVE_MESSAGES = 5000
MAX_ARCHIVE_CHARS = 1_500_000  # ~375K tokens
# A matched message up to this size is returned whole; larger ones as an excerpt.
FULL_MESSAGE_MAX_CHARS = 12_000
EXCERPT_CHARS = 1_500


@dataclass(frozen=True)
class ArchivedMessage:
    message_id: str
    role: str  # "user" or "assistant"
    created_at: str
    content: str


@dataclass(frozen=True)
class ConversationArchive:
    conversation_id: str
    messages: tuple[ArchivedMessage, ...]
    truncated: bool  # older messages were left out to respect the size cap


_RUN_CONVERSATION_ARCHIVE: ContextVar[Optional[ConversationArchive]] = ContextVar(
    "helpudoc_run_conversation_archive", default=None
)

# Searches made in this run, for search_workspace's loop guard. Bound per run with the
# archive, so concurrent runs never share it.
_RUN_SEARCH_STATE: ContextVar[Optional[dict]] = ContextVar("helpudoc_run_search_state", default=None)


def parse_conversation_archive(raw: Any) -> Optional[ConversationArchive]:
    """Validate the backend's payload. Anything malformed yields None (no archive)."""
    if not isinstance(raw, dict):
        return None
    conversation_id = str(raw.get("conversationId") or "").strip()
    entries = raw.get("messages")
    if not conversation_id or not isinstance(entries, list):
        return None
    messages: list[ArchivedMessage] = []
    total = 0
    truncated = bool(raw.get("truncated"))
    # Newest last in the payload; keep the newest when the defensive cap applies.
    for entry in reversed(entries[-MAX_ARCHIVE_MESSAGES:]):
        if not isinstance(entry, dict):
            continue
        role = str(entry.get("role") or "")
        content = entry.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
            continue
        if total + len(content) > MAX_ARCHIVE_CHARS:
            truncated = True
            break
        total += len(content)
        messages.append(
            ArchivedMessage(
                message_id=str(entry.get("id") or ""),
                role=role,
                created_at=str(entry.get("createdAt") or ""),
                content=content,
            )
        )
    if len(entries) > MAX_ARCHIVE_MESSAGES:
        truncated = True
    messages.reverse()
    return ConversationArchive(conversation_id=conversation_id, messages=tuple(messages), truncated=truncated)


def bind_run_conversation_archive(raw: Any) -> Optional[ConversationArchive]:
    """Bind this run's archive to the current task. Call at the start of the run's task."""
    archive = parse_conversation_archive(raw)
    _RUN_CONVERSATION_ARCHIVE.set(archive)
    _RUN_SEARCH_STATE.set({"empty_queries": set(), "empty_count": 0})
    return archive


def run_search_state() -> dict:
    """This run's search history. Outside a bound run (tests), a fresh throwaway state."""
    state = _RUN_SEARCH_STATE.get()
    return state if state is not None else {"empty_queries": set(), "empty_count": 0}


def current_conversation_archive() -> Optional[ConversationArchive]:
    return _RUN_CONVERSATION_ARCHIVE.get()


def _matches(text: str, phrase: str, tokens: Iterable[str]) -> bool:
    haystack = text.lower()
    if phrase and phrase in haystack:
        return True
    token_list = list(tokens)
    return bool(token_list) and all(token in haystack for token in token_list)


def _excerpt(text: str, phrase: str, limit: int = EXCERPT_CHARS) -> str:
    lowered = text.lower()
    index = lowered.find(phrase) if phrase else -1
    start = max(0, (index if index >= 0 else 0) - limit // 3)
    end = min(len(text), start + limit)
    return ("…" if start else "") + text[start:end].strip() + ("…" if end < len(text) else "")


def search_conversation_archive(
    archive: ConversationArchive, phrase: str, tokens: list[str], limit: int
) -> list[dict[str, Any]]:
    """Matching messages, newest first. Small messages whole, large ones as excerpts."""
    results: list[dict[str, Any]] = []
    for message in reversed(archive.messages):
        if not _matches(message.content, phrase, tokens):
            continue
        whole = len(message.content) <= FULL_MESSAGE_MAX_CHARS
        results.append(
            {
                "messageId": message.message_id,
                "role": message.role,
                "createdAt": message.created_at,
                "text": message.content if whole else _excerpt(message.content, phrase),
                "complete": whole,
                "chars": len(message.content),
            }
        )
        if len(results) >= limit:
            break
    return results


def log_conversation_search(archive: Optional[ConversationArchive], query: str, hits: int, user_id: str) -> None:
    """Audit line without any message content or query text."""
    logger.info(
        "Conversation archive searched",
        extra={
            "conversation_id": archive.conversation_id if archive else None,
            "user_id": user_id or None,
            "archive_messages": len(archive.messages) if archive else 0,
            "hits": hits,
            "query_chars": len(query or ""),
        },
    )
