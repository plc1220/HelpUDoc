"""A run that would end with no reply is asked once for one."""
from __future__ import annotations

from typing import Any, Callable

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool

from helpudoc_agent.middleware.empty_reply import EmptyReplyMiddleware, is_nudge


class Model(BaseChatModel):
    reply: Callable[[list], AIMessage]

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs: Any):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self.reply(messages))])


@tool
def look_up(q: str) -> str:
    """Look up."""
    return f"found {q}"


def _reply_agent(reply):
    return create_agent(model=Model(reply=reply), tools=[look_up], middleware=[EmptyReplyMiddleware()])


def test_an_empty_reply_is_asked_for_once():
    def reply(messages):
        return AIMessage("Example Pay") if is_nudge(messages[-1]) else AIMessage("")

    messages = _reply_agent(reply).invoke({"messages": [HumanMessage("which provider?")]})["messages"]
    assert messages[-1].content == "Example Pay"
    calls = []

    def never(messages):
        calls.append(1)
        return AIMessage("")

    _reply_agent(never).invoke({"messages": [HumanMessage("hi")]})
    assert len(calls) == 2  # asked once, then it stops


def test_normal_replies_and_result_tools_are_not_nudged():
    result = _reply_agent(lambda m: AIMessage("done")).invoke({"messages": [HumanMessage("hi")]})
    assert not any(is_nudge(m) for m in result["messages"])
    guard = EmptyReplyMiddleware()
    card = [HumanMessage("make a skill"), ToolMessage("{}", tool_call_id="1", name="propose_skill"), AIMessage("")]
    assert guard.after_model({"messages": card}, None) is None
    assert guard.after_model({"messages": [AIMessage("", tool_calls=[{"name": "x", "args": {}, "id": "1"}])]}, None) is None


@pytest.mark.parametrize("empty", ["", [], [{"type": "text", "text": ""}]])
def test_the_request_after_the_nudge_is_one_gemini_accepts(empty):
    # an empty list became a message with no parts, and Gemini
    # rejected the request with 400.
    from langchain_google_genai.chat_models import _parse_chat_history

    sent = []

    def reply(messages):
        sent.append(list(messages))
        return AIMessage("Example Pay") if is_nudge(messages[-1]) else AIMessage(empty)

    result = _reply_agent(reply).invoke({"messages": [HumanMessage("which provider?")]})["messages"]
    assert result[-1].content == "Example Pay"
    _, history = _parse_chat_history(sent[-1])
    assert all(content.parts for content in history)
    assert not any(isinstance(m, AIMessage) for m in sent[-1])
