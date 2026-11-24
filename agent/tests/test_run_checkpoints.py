"""Run checkpoints stay bounded, and everything the user can still answer survives."""
from __future__ import annotations

import asyncio
import base64

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from helpudoc_agent import run_checkpoints as checkpoints
from helpudoc_agent.run_checkpoints import BoundedMemorySaver, settle_run_thread
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from typing import Any, Callable

MB = 1024 * 1024
FILE = base64.b64encode(b"x" * (2 * MB)).decode()


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


@tool
def ask(q: str) -> str:
    """Ask the user."""
    return f"user said {interrupt({'question': q})}"


def _script(steps: list[tuple[str, int]]):
    """Call each tool the given number of times, then answer with every tool result."""
    plan = [name for name, count in steps for _ in range(count)]

    def reply(messages):
        done = [m for m in messages if isinstance(m, ToolMessage)]
        if len(done) < len(plan):
            return AIMessage("", tool_calls=[{"name": plan[len(done)], "args": {"q": str(len(done))}, "id": f"c{len(done)}"}])
        return AIMessage(" | ".join(str(m.content) for m in done))

    return reply


def _agent(saver, steps):
    return create_agent(model=Model(reply=_script(steps)), tools=[look_up, ask], checkpointer=saver)


def _cfg(thread: str) -> dict:
    return {"configurable": {"thread_id": thread}, "recursion_limit": 300}


def _turn() -> dict:
    return {"messages": [HumanMessage(content=[
        {"type": "text", "text": "go"},
        {"type": "file", "base64": FILE, "mime_type": "application/pdf", "filename": "a.pdf"},
    ])]}


async def _run(agent, saver, payload, thread):
    result = await agent.ainvoke(payload, config=_cfg(thread))
    await settle_run_thread(agent, saver, _cfg(thread), saw_interrupt=False)
    return result


def test_a_long_run_does_not_grow_with_its_steps():
    plain, bounded = MemorySaver(), BoundedMemorySaver()
    for saver in (plain, bounded):
        _agent(saver, [("look_up", 25)]).invoke(_turn(), config=_cfg("t"))
    size = lambda s: sum(len(v[1]) for v in s.blobs.values())
    assert size(plain) > 20 * len(FILE)
    assert size(bounded) < 6 * len(FILE)


def test_many_finished_runs_stay_under_the_limit(monkeypatch):
    monkeypatch.setattr(checkpoints, "FINISHED_MAX_BYTES", 5 * len(FILE))
    saver = BoundedMemorySaver()

    async def go():
        for n in range(20):
            await _run(_agent(saver, [("look_up", 6)]), saver, _turn(), f"t{n}")

    asyncio.run(go())
    assert saver.total_bytes() < 7 * len(FILE)
    assert "t0" not in saver.storage and "t19" in saver.storage
    assert not [k for k in saver.writes if k[0] == "t0"]


@pytest.mark.parametrize("steps", [[("ask", 1)], [("look_up", 12), ("ask", 1)], [("ask", 1), ("look_up", 5), ("ask", 1)]])
def test_paused_runs_resume_exactly_as_with_the_stock_saver(steps, monkeypatch):
    monkeypatch.setattr(checkpoints, "FINISHED_MAX_BYTES", 1)

    async def go(saver):
        agent = _agent(saver, steps)
        result = await _run(agent, saver, _turn(), "paused")
        answers = 0
        while result.get("__interrupt__"):
            # Other runs come and go while this one waits.
            for n in range(5):
                await _run(_agent(saver, [("look_up", 4)]), saver, _turn(), f"other{answers}{n}")
            if isinstance(saver, BoundedMemorySaver):
                assert "paused" in saver._waiting
                saver._quietly(saver._prune, "paused", 1)  # what a later sweep does
            result = await _run(agent, saver, Command(resume=f"answer {answers}"), "paused")
            answers += 1
        return [(m.type, str(m.content)) for m in result["messages"]], answers

    assert asyncio.run(go(BoundedMemorySaver())) == asyncio.run(go(MemorySaver()))


def test_a_finished_run_can_still_be_continued():
    # The backend can decide that a finished run is waiting for the user after all.
    async def go(saver):
        agent = _agent(saver, [("look_up", 8)])
        await _run(agent, saver, _turn(), "t")
        result = await _run(agent, saver, {"messages": [HumanMessage("and then?")]}, "t")
        return [m.type for m in result["messages"]]

    assert asyncio.run(go(BoundedMemorySaver())) == asyncio.run(go(MemorySaver()))


def test_waiting_threads_expire_only_after_a_day():
    now = [0.0]
    saver = BoundedMemorySaver(clock=lambda: now[0])

    async def go():
        await _run(_agent(saver, [("ask", 1)]), saver, _turn(), "paused")
        now[0] = checkpoints.WAITING_TTL_SECONDS - 10
        await _run(_agent(saver, [("look_up", 1)]), saver, _turn(), "a")
        assert "paused" in saver.storage
        now[0] = checkpoints.WAITING_TTL_SECONDS + 400
        await _run(_agent(saver, [("look_up", 1)]), saver, _turn(), "b")
        assert "paused" not in saver.storage

    asyncio.run(go())


def test_a_cleanup_failure_keeps_the_data_and_never_raises(monkeypatch):
    saver = BoundedMemorySaver()
    monkeypatch.setattr(saver, "_prune", lambda *a: 1 / 0)
    monkeypatch.setattr(saver, "_sweep", lambda *a: 1 / 0)

    async def go():
        result = await _run(_agent(saver, [("look_up", 3)]), saver, _turn(), "t")
        assert "found 2" in str(result["messages"][-1].content)

    asyncio.run(go())
    assert "t" in saver.storage


def test_when_unsure_the_thread_is_kept():
    class Broken:
        async def aget_state(self, *args, **kwargs):
            raise RuntimeError("unavailable")

    saver = BoundedMemorySaver()
    _agent(saver, [("look_up", 1)]).invoke(_turn(), config=_cfg("t"))
    asyncio.run(settle_run_thread(Broken(), saver, _cfg("t"), saw_interrupt=False))
    assert "t" in saver.storage and "t" not in saver._finished


def test_concurrent_runs_do_not_affect_each_other():
    saver = BoundedMemorySaver()

    async def go():
        runs = [_run(_agent(saver, [("look_up", 10)]), saver, _turn(), f"t{n}") for n in range(8)]
        return await asyncio.gather(*runs)

    assert all("found 9" in str(r["messages"][-1].content) for r in asyncio.run(go()))
