"""A tool call that Gemini wrote as text must be asked for again, never shown and never run."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver

import helpudoc_agent.middleware.empty_reply as empty_reply
from helpudoc_agent.api.message_utils import prepare_current_turn_payload
from helpudoc_agent.run_work import bind_run_work
from helpudoc_agent.written_tool_call import (
    STILL_WRITTEN_TEXT,
    WrittenToolCallError,
    is_written_tool_call,
    may_be_written_tool_call,
)

LEAK = "call:default_api:read_page{n:1}"
# The three shapes seen in real runs, and forms that other Gemini users reported.
WRITTEN = [
    "call:default_api:write_todos{todos:[{content:Read the rules (part 1), then map them,status:completed},{content:Build the tables,status:completed}]}",
    "call:default_api:inspect_document{cell_range:A1:H22,file_path:/Rules.xlsx,sheet_name:Updates}",
    "call:default_api:write_file{content:# Report\n\n**Date:** today\n\n| A | B |\n|---|---|\n| {x} | 2 |\n\n---\n*Ready.*\n,file_path:/Report.md}",
    ":call:default_api:view_file{AbsolutePath:/a,EndLine:785}",
    "<call:default_api:report xmlns:default_api=\"default_api\" names:[a,b],title:Rules/>",
    "print(default_api.search(query='x', limit=3))",
    "```tool_code\nprint(default_api.search(query='x'))\n```",
    "\n  call:default_api:read_page{n:1}\n",
]
KEPT = [
    "",
    "The answer is 4.",
    "call the customer first",
    "Call:default_api is how Gemini names its tools.",
    "call:default_api:read_page{n:1} is text that Gemini writes by mistake.",
    "Gemini wrote `call:default_api:read_page{n:1}`",
    "```python\nprint('x')\n```",
    "print(default_api.search(query='x')) does not run.",
    "```tool_code\nnotes\n```",
    '{"call": "default_api"}',
    "call:default_api:write_file{content:cut off",
]


@pytest.mark.parametrize("text", WRITTEN)
def test_a_written_call_is_recognised(text):
    assert is_written_tool_call(text)
    assert all(may_be_written_tool_call(text[:n]) for n in range(len(text) + 1))


@pytest.mark.parametrize("text", KEPT)
def test_an_answer_is_not_mistaken_for_one(text):
    assert not is_written_tool_call(text)


def test_only_text_is_examined():
    assert not is_written_tool_call([{"type": "text", "text": LEAK}]) and not is_written_tool_call(None)


@pytest.mark.parametrize("text", ["The answer", "Calls", "# Title", "| A |", "printed", "```python", "<table>", "ca l"])
def test_ordinary_text_is_released_at_once(text):
    assert not may_be_written_tool_call(text)


RAN: list = []


@tool
def read_page(n: int) -> str:
    """Read."""
    RAN.append(n)
    return f"page {n}"


CALL = AIMessage("", tool_calls=[{"name": "read_page", "args": {"n": 7}, "id": "c1"}])


def _reply(content: Any, reason: str = "STOP") -> AIMessage:
    return AIMessage(content, response_metadata={"finish_reason": reason})


class Scripted(BaseChatModel):
    """Returns the next reply of a list, and the last one for ever after."""

    replies: list
    log: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs: Any):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        reply = self.replies[min(len(self.log), len(self.replies) - 1)]
        self.log.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=reply.model_copy(deep=True))])


def _run(*replies, sync: bool = False, limit: int = 300):
    RAN.clear()
    model = Scripted(replies=list(replies), log=[])
    agent = create_agent(
        model=model, tools=[read_page], middleware=[empty_reply.EmptyReplyMiddleware()], checkpointer=MemorySaver()
    )
    config = {"recursion_limit": limit, "configurable": {"thread_id": "t"}}

    async def go():
        bind_run_work()
        start = {"messages": [HumanMessage("q")]}
        return agent.invoke(start, config) if sync else await agent.ainvoke(start, config)

    return asyncio.run(go()), model


@pytest.mark.parametrize("sync", [False, True])
@pytest.mark.parametrize("text", WRITTEN)
def test_the_call_is_asked_for_again_and_the_run_goes_on(text, sync):
    result, model = _run(_reply(text), CALL, _reply("ANSWER"), sync=sync)
    assert result["messages"][-1].content == "ANSWER" and RAN == [7]
    assert not any("default_api" in str(m.content) for m in result["messages"])
    assert [m.content for m in model.log[1]] == [m.content for m in model.log[0]]  # sent unchanged


def test_the_written_call_is_never_run():
    _run(_reply(LEAK), _reply("ANSWER"))
    assert RAN == []


def test_a_second_failure_is_corrected_and_the_correction_is_not_kept():
    result, model = _run(_reply(LEAK), _reply(LEAK), CALL, _reply("ANSWER"))
    assert "written as text" in str(model.log[2][-1].content)
    assert result["messages"][-1].content == "ANSWER" and RAN == [7]
    assert not any("system note" in str(m.content) for m in result["messages"])


def test_after_that_it_is_asked_for_the_answer_it_has():
    result, model = _run(*[_reply(LEAK)] * 3, _reply("PARTIAL"))
    assert len(model.log) == 4 and "ended without a reply" in str(model.log[3][-1].content)
    assert result["messages"][-1].content == "PARTIAL"


def test_a_model_that_only_writes_calls_fails_in_plain_words():
    with pytest.raises(WrittenToolCallError) as error:
        _run(_reply(LEAK))
    assert str(error.value) == STILL_WRITTEN_TEXT and "default_api" not in str(error.value)


def test_a_work_limit_note_does_not_start_the_attempts_again():
    with pytest.raises(WrittenToolCallError):
        _run(_reply(LEAK), limit=80)


def test_the_number_of_calls_is_bounded():
    model = Scripted(replies=[_reply(LEAK)], log=[])
    agent = create_agent(model=model, tools=[read_page], middleware=[empty_reply.EmptyReplyMiddleware()])
    with pytest.raises(WrittenToolCallError):
        agent.invoke({"messages": [HumanMessage("q")]})
    assert len(model.log) == 6


@pytest.mark.parametrize("reason", ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"])
def test_a_call_that_gemini_rejected_is_asked_for_again(reason):
    result, model = _run(_reply("", reason), CALL, _reply("ANSWER"))
    assert result["messages"][-1].content == "ANSWER" and RAN == [7]


def test_a_rejected_call_that_repeats_ends_as_an_empty_reply_does():
    result, model = _run(*[_reply("", "MALFORMED_FUNCTION_CALL")] * 3, _reply("PARTIAL"))
    assert result["messages"][-1].content == "PARTIAL"


def test_text_the_user_has_seen_is_not_asked_for_again():
    result, model = _run(_reply("The full answer.", "MALFORMED_FUNCTION_CALL"))
    assert len(model.log) == 1 and result["messages"][-1].content == "The full answer."


@pytest.mark.parametrize("text", [t for t in KEPT if t])
def test_an_ordinary_answer_is_sent_once_and_unchanged(text):
    result, model = _run(_reply(text))
    assert len(model.log) == 1 and result["messages"][-1].content == text


def test_a_real_call_beside_the_text_is_left_alone():
    both = AIMessage(LEAK, tool_calls=[{"name": "read_page", "args": {"n": 3}, "id": "c1"}])
    result, model = _run(both, _reply("ANSWER"))
    assert len(model.log) == 2 and RAN == [3]


def test_gemini_content_blocks_are_read_too():
    result, _ = _run(_reply([{"type": "text", "text": LEAK, "index": 0}]), _reply("ANSWER"))
    assert result["messages"][-1].content == "ANSWER"


def test_it_adds_no_graph_steps():
    def steps(*replies):
        model = Scripted(replies=list(replies), log=[])
        agent = create_agent(model=model, tools=[read_page], middleware=[empty_reply.EmptyReplyMiddleware()])
        return len(list(agent.stream({"messages": [HumanMessage("q")]}, stream_mode="updates")))

    assert steps(CALL, _reply("A")) == steps(CALL, _reply(LEAK), _reply(LEAK), _reply("A"))


def test_a_written_call_in_the_last_answer_does_not_count_as_one(monkeypatch):
    monkeypatch.setattr(empty_reply, "EMPTY_SEARCHES_STOP", 0)
    result, _ = _run(_reply(LEAK), _reply("PLAIN"))
    assert result["messages"][-1].content == "PLAIN"


def test_the_log_holds_no_user_data(caplog):
    _run(_reply("call:default_api:read_page{name:Secret Person}"), _reply("ANSWER"))
    assert "Secret" not in caplog.text and "finish_reason=STOP" in caplog.text


def test_a_saved_written_call_is_not_sent_to_the_model():
    history = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": LEAK},
        {"role": "user", "content": LEAK},
        {"role": "assistant", "content": f"Gemini wrote {LEAK}"},
    ]
    payload = prepare_current_turn_payload("next", list(history))
    assert payload == [history[0], history[2], history[3], {"role": "user", "content": "next"}]
    assert len(history) == 4
