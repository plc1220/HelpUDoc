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
"""
from __future__ import annotations

from typing import Any

from langchain.agents.middleware.summarization import SummarizationMiddleware
from langchain_core.messages import AnyMessage, HumanMessage

# Keep the newest messages up to this many estimated tokens. The rest is summarized.
# Large enough for several recent turns, small enough that the result sits well under
# the trigger, so one turn does not summarize twice.
SUMMARY_KEEP_TOKENS = 40000

# How much of the older history the summarizer reads (LangChain's default is 4,000).
SUMMARY_READ_TOKENS = 80000

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


class AriaSummarizationMiddleware(SummarizationMiddleware):
    """SummarizationMiddleware that never summarizes away the user's latest message."""

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
            return last_user_turn
        return cutoff


def build_summarization_middleware(model: Any, trigger_tokens: int) -> AriaSummarizationMiddleware:
    return AriaSummarizationMiddleware(
        model=model,
        trigger=("tokens", trigger_tokens),
        keep=("tokens", SUMMARY_KEEP_TOKENS),
        trim_tokens_to_summarize=SUMMARY_READ_TOKENS,
        summary_prompt=ARIA_SUMMARY_PROMPT,
    )
