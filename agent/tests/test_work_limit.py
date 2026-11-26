"""A run near its step limit must end with a partial answer instead of an error."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError

import helpudoc_agent.middleware.empty_reply as empty_reply
from helpudoc_agent.run_work import bind_run_work, remaining_steps, stopped_at_the_limit


@tool
def read_page(n: int) -> str:
    """Read."""
    return f"page {n}"


class Reader(BaseChatModel):
    """Reads pages for ever while it has tools."""

    log: list = []
    stop_at: int = 10_000

    @property
    def _llm_type(self) -> str:
        return "reader"

    def bind_tools(self, tools, **kwargs: Any):
        return self.bind(n=len(tools))

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        n = len(self.log)
        self.log.append((kwargs.get("n", 0), str(messages[-1].content)))
        if n >= self.stop_at or not kwargs.get("n"):
            reply = AIMessage("ANSWER")
        else:
            reply = AIMessage("", tool_calls=[{"name": "read_page", "args": {"n": n}, "id": f"c{n}"}])
        return ChatResult(generations=[ChatGeneration(message=reply)])


class Step(AgentMiddleware):
    def after_model(self, state, runtime):
        return None


def _run(limit: int, bind: bool = True, **kwargs: Any):
    model = Reader(log=[], **kwargs)
    agent = create_agent(model=model, tools=[read_page], middleware=[empty_reply.EmptyReplyMiddleware(), Step()], checkpointer=MemorySaver())

    async def go():
        if bind:
            bind_run_work()
        config = {"recursion_limit": limit, "configurable": {"thread_id": "t"}}
        first = await agent.ainvoke({"messages": [HumanMessage("q")]}, config)
        return first, stopped_at_the_limit(), agent, config

    return (*asyncio.run(go()), model)


def test_a_run_at_its_limit_answers_instead_of_failing():
    result, stopped, _, _, model = _run(300)
    assert result["messages"][-1].content == "ANSWER" and stopped
    assert model.log[-1][0] == 0 and "work limit" in model.log[-1][1]
    assert not any("system note" in str(m.content) for m in result["messages"])


def test_it_is_warned_before_it_is_stopped():
    *_, model = _run(300)
    warned = [i for i, (_, text) in enumerate(model.log) if "close to its work limit" in text]
    assert warned and warned[-1] < len(model.log) - 1 and warned[0] > 40


def test_a_run_that_finishes_in_time_is_unchanged():
    result, stopped, _, _, model = _run(1000, stop_at=30)
    assert len(model.log) == 31 and not stopped and not any("system note" in t for _, t in model.log)


def test_a_run_that_is_not_bound_behaves_as_before():
    with pytest.raises(GraphRecursionError):
        _run(300, bind=False)


def test_a_second_run_on_the_thread_has_its_own_limit():
    _, _, agent, config, model = _run(300)
    calls = len(model.log)

    async def again():
        bind_run_work()
        return await agent.ainvoke({"messages": [HumanMessage("continue")]}, config), stopped_at_the_limit()

    result, stopped = asyncio.run(again())
    assert result["messages"][-1].content == "ANSWER" and stopped
    assert abs((len(model.log) - calls) - calls) <= 2


def test_a_pending_form_is_not_cut_off(monkeypatch):
    monkeypatch.setattr(empty_reply, "next_pending_gate", lambda context: {"gate_id": "x"})
    with pytest.raises(GraphRecursionError):
        _run(300)


def test_concurrent_runs_do_not_share_the_count():
    async def one(limit):
        bind_run_work()
        remaining_steps({"recursion_limit": limit, "metadata": {"langgraph_step": 5}})
        await asyncio.sleep(0)
        return remaining_steps({"recursion_limit": limit, "metadata": {"langgraph_step": 25}})

    async def both():
        return await asyncio.gather(asyncio.create_task(one(100)), asyncio.create_task(one(500)))

    assert asyncio.run(both()) == [80, 480]


def test_unknown_configuration_is_ignored():
    bind_run_work()
    for config in (None, {}, {"recursion_limit": 5}, {"recursion_limit": "x", "metadata": {"langgraph_step": 1}}):
        assert remaining_steps(config) is None


def test_a_run_that_heeds_the_warning_is_also_marked():
    class Heeds(Reader):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
            if "close to its work limit" in str(messages[-1].content):
                return ChatResult(generations=[ChatGeneration(message=AIMessage("PART"))])
            return super()._generate(messages, stop, run_manager, **kwargs)

    async def go():
        bind_run_work()
        agent = create_agent(model=Heeds(log=[]), tools=[read_page], middleware=[empty_reply.EmptyReplyMiddleware(), Step()])
        result = await agent.ainvoke({"messages": [HumanMessage("q")]}, {"recursion_limit": 300})
        return result["messages"][-1].content, stopped_at_the_limit()

    assert asyncio.run(go()) == ("PART", True)
