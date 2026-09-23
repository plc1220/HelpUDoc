"""The response stream must stop the agent run when its reader goes away.

`cancelAgentRun` aborts the HTTP request; Starlette then cancels the streaming
generator. Before `_settle_agent_task` the generator only awaited the runner
task, so the run carried on calling Gemini and writing workspace files after the
backend had marked it `cancelled` and released the workspace mutation lease.
"""
from __future__ import annotations

import asyncio

from helpudoc_agent.api.routes import chat as chat_routes
from helpudoc_agent.api.routes.chat import _settle_agent_task


async def _never_finishes(started: asyncio.Event, ran_to_completion: list[bool]) -> None:
    started.set()
    await asyncio.sleep(3600)
    ran_to_completion.append(True)


async def _spawn_running_task() -> tuple[asyncio.Task, list[bool]]:
    started = asyncio.Event()
    ran_to_completion: list[bool] = []
    task = asyncio.create_task(_never_finishes(started, ran_to_completion))
    await started.wait()
    return task, ran_to_completion


def test_reader_leaving_mid_run_cancels_the_agent():
    """The disconnect case: no terminal event, no interrupt."""

    async def scenario() -> tuple[bool, list[bool]]:
        task, ran_to_completion = await _spawn_running_task()
        await _settle_agent_task(
            task,
            stream_completed=False,
            saw_interrupt=False,
            label="test",
        )
        return task.cancelled(), ran_to_completion

    cancelled, ran_to_completion = asyncio.run(scenario())

    assert cancelled, "an abandoned run must not keep calling the model"
    assert not ran_to_completion


def test_emitted_interrupt_is_left_to_commit_its_checkpoint(monkeypatch):
    """The backend closes the stream as soon as it parses the interrupt line.

    Cancelling there can abort the LangGraph checkpoint write that makes the
    approval resumable, turning a pending approval into a dead run. The helper
    waits instead -- but gives up rather than pinning the response teardown to a
    wedged run.
    """
    monkeypatch.setattr(chat_routes, "_AGENT_TASK_SETTLE_TIMEOUT_S", 0.05)

    async def scenario() -> tuple[bool, bool]:
        task, _ = await _spawn_running_task()
        await asyncio.wait_for(
            _settle_agent_task(
                task,
                stream_completed=False,
                saw_interrupt=True,
                label="test",
            ),
            timeout=5,
        )
        outcome = (task.cancelled(), task.done())
        task.cancel()
        return outcome

    cancelled, done = asyncio.run(scenario())

    assert not cancelled, "an interrupted run must be allowed to finish its checkpoint"
    assert not done


def test_completed_stream_leaves_the_finished_task_alone():
    async def scenario() -> tuple[bool, str]:
        async def _finishes() -> str:
            return "ok"

        task = asyncio.create_task(_finishes())
        await _settle_agent_task(
            task,
            stream_completed=True,
            saw_interrupt=False,
            label="test",
        )
        return task.cancelled(), task.result()

    cancelled, result = asyncio.run(scenario())

    assert not cancelled
    assert result == "ok"


def test_runner_failure_does_not_mask_why_the_stream_closed():
    """The runner reports its own errors on the stream; teardown must stay quiet."""

    async def scenario() -> None:
        async def _raises() -> None:
            raise RuntimeError("agent exploded")

        task = asyncio.create_task(_raises())
        # Must not propagate: it would replace the real reason the stream closed.
        await _settle_agent_task(
            task,
            stream_completed=True,
            saw_interrupt=False,
            label="test",
        )

    asyncio.run(scenario())
