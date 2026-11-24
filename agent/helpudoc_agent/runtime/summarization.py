"""Conversation summarization for long workspace chats.

LangChain's SummarizationMiddleware with settings and a prompt for ARIA. Below the
trigger nothing changes: the middleware never runs. Above it, the defaults lost the
conversation (#121):

- Keeping the last 6 *messages* could keep only the current turn's tool calls, so the
  user's own question was summarized away and the model no longer knew what was asked.
- The summarizer read only the last 4,000 tokens of the older history. A turn with one
  large tool result left it nothing to read, and it wrote "None" in every section.
- The kept messages still carried the pre-summary token usage, so the next model call in
  the same turn summarized again (three times in one run in testing).

Attached files need care. LangChain counts a PDF's base64 as text:
a 5.6 MB attachment counted as about 1.4M tokens, where Gemini used under 30K. The trigger
was always exceeded, and the attachment sits in the protected user message, so every model
step summarized the previous summary again.
"""
from __future__ import annotations

import base64
import hashlib
import io
import logging
from typing import Any, Callable, Sequence

from langchain.agents.middleware.summarization import SummarizationMiddleware
from langchain_core.messages import AnyMessage, HumanMessage

logger = logging.getLogger(__name__)

# Keep the newest messages up to this many estimated tokens. The rest is summarized.
# Large enough for several recent turns, small enough that the result sits well under
# the trigger, so one turn does not summarize twice.
SUMMARY_KEEP_TOKENS = 40000

# How much of the older history the summarizer reads (LangChain's default is 4,000).
SUMMARY_READ_TOKENS = 80000

# Estimated tokens for a PDF page, on the high side of Gemini's 258, so that a conversation
# is compressed early rather than too late.
PDF_PAGE_TOKENS = 600
# Used when a PDF cannot be read: assume a page for every 20 KB.
_PDF_BYTES_PER_PAGE = 20_000

# The only placeholder is {messages}: LangChain fills this with str.format, so any other
# literal brace must be doubled.
ARIA_SUMMARY_PROMPT = """You are compressing an ARIA conversation so the assistant can keep working.
The summary replaces the older messages below. The user never sees it. Do not answer
the user or continue the task here; only record context.

Write in the user's language. Keep exact file paths, template and skill names, IDs,
table names, figures and dates. Do not invent anything. Write "None" only when the
conversation truly has nothing for that section.

## Current request
The user's most recent request in these messages, quoted verbatim, and what a complete
answer must contain.

## Goal of the conversation
The overall task across all turns, in one or two sentences.

## Workspace files and templates
Every file, folder, template or dashboard that was read, created or changed, with its
path and one line on its role (e.g. "templates/2a.md: format the user wants for replies").

## Decisions and preferences
What the user chose, approved or rejected, and why. Formatting, tone and structure
preferences. Plan or action approvals that were given.

## Data and findings
Sources used (BigQuery tables, MCP tools, uploaded documents, web) and the key results,
numbers and conclusions, with the query or file each came from.

## Open items
Questions waiting for the user, pending approvals, failed steps and their errors,
and what remains to be done next.

<messages>
{messages}
</messages>

Respond only with the sections above."""


def _is_user_turn(message: AnyMessage) -> bool:
    # A previous summary is also a HumanMessage; it is not something the user asked.
    return isinstance(message, HumanMessage) and (
        message.additional_kwargs.get("lc_source") != "summarization"
    )


def _is_summary(message: AnyMessage) -> bool:
    return isinstance(message, HumanMessage) and not _is_user_turn(message)


# Estimates by content fingerprint. The cache never holds the files themselves.
_PDF_TOKENS: dict[bytes, int] = {}
_PDF_TOKENS_MAX_ENTRIES = 256


def _inline_pdf(block: Any) -> str | None:
    """The base64 of an attached PDF, or None. Images already have a fixed cost in LangChain."""
    if not isinstance(block, dict) or block.get("type") not in {"file", "media"}:
        return None
    if block.get("mime_type") != "application/pdf":
        return None
    data = block.get("base64") or block.get("data")
    return data if isinstance(data, str) else None


def _pdf_tokens(data: str) -> int:
    """Estimated tokens. Never raises: an unreadable file must not fail the run."""
    key = hashlib.sha256(data.encode("utf-8", "replace")).digest()
    known = _PDF_TOKENS.get(key)
    if known is not None:
        return known
    try:
        from pypdf import PdfReader

        pages = len(PdfReader(io.BytesIO(base64.b64decode(data))).pages)
    except Exception:
        logger.debug("PDF page count unavailable", exc_info=True)
        pages = len(data) * 3 // 4 // _PDF_BYTES_PER_PAGE
    tokens = max(1, pages) * PDF_PAGE_TOKENS
    if len(_PDF_TOKENS) >= _PDF_TOKENS_MAX_ENTRIES:
        _PDF_TOKENS.clear()
    _PDF_TOKENS[key] = tokens
    return tokens


def count_with_attachments(counter: Callable[..., int], messages: Sequence[AnyMessage]) -> int:
    """counter's result with attached PDFs at their real cost. Everything else is unchanged."""
    extra = 0
    counted: list[AnyMessage] = []
    for message in messages:
        content = message.content
        if isinstance(content, list):
            kept = []
            for block in content:
                data = _inline_pdf(block)
                if data is None:
                    kept.append(block)
                else:
                    extra += _pdf_tokens(data)
            if len(kept) != len(content):
                message = message.model_copy(update={"content": kept})
        counted.append(message)
    return counter(counted) + extra


class AriaSummarizationMiddleware(SummarizationMiddleware):
    """SummarizationMiddleware that never summarizes away the user's latest message."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        full, partial_count = self.token_counter, self._partial_token_counter
        self.token_counter = lambda messages: count_with_attachments(full, messages)
        self._partial_token_counter = lambda messages: count_with_attachments(partial_count, messages)

    @property
    def name(self) -> str:
        # The graph node is named after the middleware. Keep LangChain's name so the
        # chat stream filter (api/routes/chat.py) and existing traces still match it.
        return "SummarizationMiddleware"

    def _determine_cutoff_index(self, messages: list[AnyMessage]) -> int:
        cutoff = super()._determine_cutoff_index(messages)
        last_user_turn = next(
            (index for index in range(len(messages) - 1, -1, -1) if _is_user_turn(messages[index])),
            None,
        )
        # Messages before the cutoff are summarized. A human message is never inside a
        # tool call/result pair, so cutting at it is always safe.
        if last_user_turn is not None and cutoff > last_user_turn:
            cutoff = last_user_turn
        # Only an earlier summary would be summarized: that frees nothing and loses detail.
        if all(_is_summary(message) for message in messages[:cutoff]):
            return 0
        return cutoff


def build_summarization_middleware(model: Any, trigger_tokens: int) -> AriaSummarizationMiddleware:
    return AriaSummarizationMiddleware(
        model=model,
        trigger=("tokens", trigger_tokens),
        keep=("tokens", SUMMARY_KEEP_TOKENS),
        trim_tokens_to_summarize=SUMMARY_READ_TOKENS,
        summary_prompt=ARIA_SUMMARY_PROMPT,
    )
