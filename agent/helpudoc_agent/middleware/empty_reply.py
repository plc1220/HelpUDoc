"""Ask once for a reply when a run would end with none.

Long runs in testing and production sometimes ended on an empty model message after many
tool calls. The user saw "Completed successfully." and no answer.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, hook_config
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage
from langgraph.runtime import Runtime

from helpudoc_agent.interaction_contract import next_pending_gate

logger = logging.getLogger(__name__)

NUDGE_SOURCE = "lumo_empty_reply"
NUDGE_TEXT = (
    "[Lumo system note] You ended without a reply. Write your reply to the user's latest "
    "message now, from what you already found. Do not start new work. If you could not find "
    "or finish something, say so and ask the user for what you need."
)
# Their result is the reply: a card, a form or a proposal that the user sees.
_TOOLS_THAT_END_A_RUN = {"propose_skill", "workflow_action"}


def is_nudge(message: Any) -> bool:
    return isinstance(message, HumanMessage) and message.additional_kwargs.get("lc_source") == NUDGE_SOURCE


# A search that reports no result. After this many in a row, with nothing found in between,
# the model is told to stop searching; after the second number it must answer.
EMPTY_SEARCHES_WARN = 8
EMPTY_SEARCHES_STOP = 15
# Planning notes the model writes for itself. They find nothing, so they do not restart the count.
_PLANNING_TOOLS = {"write_todos"}
_WARN_TEXT = (
    "[ARIA system note] Your last {n} searches found nothing. The value is probably not there. Do not "
    "make up values to search for. Use what you have read, follow the task's rule for missing values, or "
    "ask the user with request_clarification if only they can know it."
)
_STOP_TEXT = (
    "[ARIA system note] Your last {n} searches found nothing, so searching is over for this request. Answer "
    "the user's latest message now from what you have read. Say clearly what was not found. Do not invent it."
)


def _is_empty_search(message: ToolMessage) -> bool:
    content = message.content if isinstance(message.content, str) else ""
    if not content.lstrip().startswith("{"):
        return False
    try:
        result = json.loads(content)
    except ValueError:
        return False
    count = result.get("resultCount") if isinstance(result, dict) else None
    return isinstance(count, int) and not isinstance(count, bool) and count == 0


def empty_searches_in_a_row(messages: Any) -> int:
    """Searches without a result since the last useful tool result or user message."""
    count = 0
    for message in reversed(messages or []):
        if isinstance(message, ToolMessage):
            if message.name in _PLANNING_TOOLS:
                continue
            if not _is_empty_search(message):
                break
            count += 1
        elif isinstance(message, HumanMessage) and not is_nudge(message):
            break
    return count


def _without_tool_calls(response: Any) -> Any:
    result = getattr(response, "result", None)
    if not isinstance(result, list):
        return response
    for index, message in enumerate(result):
        if isinstance(message, AIMessage) and (message.tool_calls or message.invalid_tool_calls):
            text = message.text if isinstance(message.text, str) else message.text()
            result[index] = AIMessage(
                str(text), id=message.id, usage_metadata=message.usage_metadata,
                response_metadata=message.response_metadata,
            )
    return response


_FALLBACK_TEXT = (
    "I stopped because repeated searches found nothing, and I could not complete the answer. The values I "
    "searched for do not appear to be in the files I checked. Please check the value, or tell me which file "
    "to use, and I will continue from there."
)
_PLAIN_RESULT_CHARS = 8000
_PLAIN_TOTAL_CHARS = 120_000
_PLAIN_TRIES = 2
# The usual instructions tell the model to plan and use tools, which it then attempts even with
# none available. The final answer is asked for without them.
_PLAIN_SYSTEM = (
    "You are ARIA. Write the final answer to the user as plain text or Markdown. You have no tools and cannot "
    "search, plan or call functions. Use only the conversation and the findings given. Keep the language and "
    "the output format the user or the findings ask for. Never invent a value: say what was not found. If the "
    "work is incomplete, say what is done and what is not."
)


def _text_of(message: Any) -> str:
    return str(message.text if isinstance(message.text, str) else message.text()).strip()


def _has_text(response: Any) -> bool:
    return any(isinstance(m, AIMessage) and _text_of(m) for m in getattr(response, "result", None) or [])


def _as_plain_text(request: Any) -> Any:
    """The same request with this turn's tool calls written out, so there is no call to imitate."""
    messages = list(request.messages)
    start = max((i for i, m in enumerate(messages[:-1]) if isinstance(m, HumanMessage) and not is_nudge(m)), default=0)
    notes: list[str] = []
    for message in messages[start + 1 : -1]:
        if isinstance(message, ToolMessage) and message.name not in _PLANNING_TOOLS:
            notes.append(f"{message.name or 'tool'}: {str(message.content)[:_PLAIN_RESULT_CHARS]}")
    found = "\n".join(notes)
    if len(found) > _PLAIN_TOTAL_CHARS:
        found = found[:_PLAIN_TOTAL_CHARS] + "\n[More findings were left out]"
    asked = _text_of(messages[start]) if isinstance(messages[start], HumanMessage) else ""
    note = HumanMessage(
        f"The user's request was:\n<request>\n{asked}\n</request>\n\nFindings so far:\n<findings>\n{found}\n"
        f"</findings>\n\n{messages[-1].content}"
    )
    # Earlier messages of the chat stay; this turn's calls are replaced by the note.
    return request.override(
        messages=[*messages[:start], note], tools=[], system_message=SystemMessage(_PLAIN_SYSTEM)
    )


def _with_some_text(response: Any) -> Any:
    if isinstance(getattr(response, "result", None), list) and not _has_text(response):
        logger.warning("No answer after the search limit; using the fixed message")
        response.result[:] = [AIMessage(_FALLBACK_TEXT)]
    return response


class EmptyReplyMiddleware(AgentMiddleware):
    @staticmethod
    def _limit_empty_searches(request: Any) -> tuple[Any, bool]:
        """The request to send, and whether it is the final answer. Any doubt: unchanged."""
        try:
            count = empty_searches_in_a_row(request.messages)
            if count < EMPTY_SEARCHES_WARN:
                return request, False
            context = getattr(request.runtime, "context", None)
            if next_pending_gate(context if isinstance(context, dict) else None) is not None:
                return request, False
            final = count >= EMPTY_SEARCHES_STOP
            logger.warning("%s searches in a row found nothing (final=%s)", count, final)
            note = HumanMessage((_STOP_TEXT if final else _WARN_TEXT).format(n=count))
            messages = [*request.messages, note]
            return (request.override(messages=messages, tools=[]) if final
                    else request.override(messages=messages)), final
        except Exception:
            logger.warning("Empty-search check skipped", exc_info=True)
            return request, False

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        request, final = self._limit_empty_searches(request)
        response = handler(request)
        if not final:
            return response
        response = _without_tool_calls(response)
        for _ in range(_PLAIN_TRIES):
            if _has_text(response):
                break
            response = _without_tool_calls(handler(_as_plain_text(request)))
        return _with_some_text(response)

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        request, final = self._limit_empty_searches(request)
        response = await handler(request)
        if not final:
            return response
        response = _without_tool_calls(response)
        for _ in range(_PLAIN_TRIES):
            if _has_text(response):
                break
            response = _without_tool_calls(await handler(_as_plain_text(request)))
        return _with_some_text(response)

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        if not isinstance(last, AIMessage) or last.tool_calls or last.invalid_tool_calls:
            return None
        if str(last.text if isinstance(last.text, str) else last.text()).strip():
            return None
        for message in reversed(messages):
            if isinstance(message, HumanMessage):
                if is_nudge(message):
                    return None
                break
            if isinstance(message, ToolMessage) and message.name in _TOOLS_THAT_END_A_RUN:
                return None
        if not last.id:
            return None
        logger.warning("Run would have ended without a reply; asking the model once")
        nudge = HumanMessage(NUDGE_TEXT, additional_kwargs={"lc_source": NUDGE_SOURCE})
        # Gemini rejects a message with no parts, so the empty one must not be sent back.
        return {"messages": [RemoveMessage(id=last.id), nudge], "jump_to": "model"}
