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
from langgraph.config import get_config
from langgraph.runtime import Runtime

from helpudoc_agent.interaction_contract import next_pending_gate
from helpudoc_agent.run_work import mark_stopped, remaining_steps
from helpudoc_agent.written_tool_call import WrittenToolCallError, is_written_tool_call

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


# Graph steps left before the run would fail. One model call with its tools takes about eight.
STEPS_LEFT_WARN = 90
STEPS_LEFT_STOP = 30
_STEPS_WARN_TEXT = (
    "[ARIA system note] This request is close to its work limit. Finish the most important part now and "
    "prepare to answer. Do not start new work."
)
_STEPS_STOP_TEXT = (
    "[ARIA system note] This request has reached its work limit. Answer the user's latest message now from "
    "what you have. Say what is done and what is not done. Do not invent anything."
)


def _steps_left() -> int | None:
    try:
        return remaining_steps(get_config())
    except Exception:
        return None  # outside a graph run


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


def _text_of(message: Any) -> str:
    return str(message.text if isinstance(message.text, str) else message.text()).strip()


def _with_text(message: AIMessage, text: str) -> AIMessage:
    return AIMessage(
        text, id=message.id, usage_metadata=message.usage_metadata, response_metadata=message.response_metadata
    )


def _without_tool_calls(response: Any) -> Any:
    result = getattr(response, "result", None)
    if not isinstance(result, list):
        return response
    for index, message in enumerate(result):
        if not isinstance(message, AIMessage):
            continue
        if is_written_tool_call(_text_of(message)):
            result[index] = _with_text(message, "")
        elif message.tool_calls or message.invalid_tool_calls:
            result[index] = _with_text(message, _text_of(message))
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


def _has_text(response: Any) -> bool:
    return any(isinstance(m, AIMessage) and _text_of(m) for m in getattr(response, "result", None) or [])


# Gemini could not turn the model's output into a call.
_BAD_CALL_REASONS = ("MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE")
_RESENDS = 2
_CORRECTION_TEXT = (
    "[ARIA system note] Your last reply was a tool call written as text, so nothing ran. Make the call with the "
    "tool interface, or write your reply to the user. Do not write a call as text."
)


def _failed_call(response: Any) -> str:
    """Why this reply is a tool call that never happened, or an empty string."""
    messages = [m for m in getattr(response, "result", None) or [] if isinstance(m, AIMessage)]
    if not messages or any(m.tool_calls or m.invalid_tool_calls for m in messages):
        return ""
    texts = [_text_of(m) for m in messages]
    if any(is_written_tool_call(text) for text in texts):
        return "written as text"
    reason = str((messages[-1].response_metadata or {}).get("finish_reason") or "")
    # A reply with other text has been shown to the user, so it is not asked for again.
    if not any(texts) and any(bad in reason for bad in _BAD_CALL_REASONS):
        return "rejected"
    return ""


def _log_failed_call(response: Any, why: str, resend: int) -> None:
    # Not the text: it holds the user's data.
    for message in response.result:
        if isinstance(message, AIMessage):
            logger.warning(
                "Tool call %s by the model (finish_reason=%s chars=%s resend=%s)",
                why, (message.response_metadata or {}).get("finish_reason"), len(_text_of(message)), resend,
            )


def _resend(request: Any, attempt: int) -> Any:
    if attempt == 0:
        return request  # usually enough: the failure is rarely repeated
    return request.override(messages=[*request.messages, HumanMessage(_CORRECTION_TEXT)])


def _blank_written_call(response: Any, request: Any) -> Any:
    """Make the reply empty, so the check for empty replies asks once more. Fail if it already did."""
    for index, message in enumerate(response.result):
        if isinstance(message, AIMessage) and not message.tool_calls and is_written_tool_call(_text_of(message)):
            latest = next((m for m in reversed(request.messages) if isinstance(m, HumanMessage)), None)
            if latest is not None and is_nudge(latest):
                raise WrittenToolCallError()
            response.result[index] = _with_text(message, "")
    return response


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
    def _limit_work(request: Any) -> tuple[Any, bool]:
        """The request to send, and whether it is the final answer. Any doubt: unchanged."""
        try:
            steps = _steps_left()
            searches = empty_searches_in_a_row(request.messages)
            if steps is not None and steps <= STEPS_LEFT_STOP:
                text, final = _STEPS_STOP_TEXT, True
            elif searches >= EMPTY_SEARCHES_STOP:
                text, final = _STOP_TEXT.format(n=searches), True
            elif searches >= EMPTY_SEARCHES_WARN:
                text, final = _WARN_TEXT.format(n=searches), False
            elif steps is not None and steps <= STEPS_LEFT_WARN:
                text, final = _STEPS_WARN_TEXT, False
            else:
                return request, False
            context = getattr(request.runtime, "context", None)
            if next_pending_gate(context if isinstance(context, dict) else None) is not None:
                return request, False
            logger.warning("Work limit note (empty searches=%s, steps left=%s, final=%s)", searches, steps, final)
            messages = [*request.messages, HumanMessage(text)]
            if text in (_STEPS_WARN_TEXT, _STEPS_STOP_TEXT):
                # Also after the warning: a model that heeds it leaves work undone.
                mark_stopped()
            if not final:
                return request.override(messages=messages), False
            return request.override(messages=messages, tools=[]), True
        except Exception:
            logger.warning("Work limit check skipped", exc_info=True)
            return request, False

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        sent, final = self._limit_work(request)
        response = handler(sent)
        if not final:
            for attempt in range(_RESENDS):
                why = _failed_call(response)
                if not why:
                    return response
                _log_failed_call(response, why, attempt + 1)
                response = handler(_resend(sent, attempt))
            return _blank_written_call(response, request)
        response = _without_tool_calls(response)
        for _ in range(_PLAIN_TRIES):
            if _has_text(response):
                break
            response = _without_tool_calls(handler(_as_plain_text(sent)))
        return _with_some_text(response)

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        sent, final = self._limit_work(request)
        response = await handler(sent)
        if not final:
            for attempt in range(_RESENDS):
                why = _failed_call(response)
                if not why:
                    return response
                _log_failed_call(response, why, attempt + 1)
                response = await handler(_resend(sent, attempt))
            return _blank_written_call(response, request)
        response = _without_tool_calls(response)
        for _ in range(_PLAIN_TRIES):
            if _has_text(response):
                break
            response = _without_tool_calls(await handler(_as_plain_text(sent)))
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
