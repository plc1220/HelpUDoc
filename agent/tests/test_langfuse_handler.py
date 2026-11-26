"""Langfuse traces stay complete without storing the conversation on every span.

Runs a real LangChain agent loop through a real Langfuse client, with spans captured in
memory instead of exported.
"""
from __future__ import annotations

import base64
import hashlib
import json
import uuid
from typing import Any

import pytest

pytest.importorskip("langfuse")

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, TodoListMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langfuse import Langfuse
from langfuse.langchain import CallbackHandler
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from helpudoc_agent.langfuse_handler import TrimmedLangfuseHandler, redact_files

FILE = b"%PDF-1.7 " + b"scanned page " * 40_000
FILE_B64 = base64.b64encode(FILE).decode()
FILE_SHA = hashlib.sha256(FILE).hexdigest()
QUESTION = "Assess case CASE-26-000002"
ANSWER = "Case CASE-26-000002: refer to Team A."
STEPS = 4


class ScriptedModel(BaseChatModel):
    tool_name: str = "look_up"
    steps: int = STEPS
    seen: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs: Any):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        self.seen.append(list(messages))
        done = sum(isinstance(m, ToolMessage) for m in messages)
        if done < self.steps:
            message = AIMessage("", tool_calls=[{"name": self.tool_name, "args": {"q": f"q{done}"}, "id": f"c{done}"}])
        else:
            message = AIMessage(ANSWER)
        return ChatResult(generations=[ChatGeneration(message=message)])


class Hooks(AgentMiddleware):
    """Stands in for Lumo's middleware: each hook becomes a chain span."""

    def before_model(self, state, runtime):
        return None

    def after_model(self, state, runtime):
        return None


@tool
def look_up(q: str) -> str:
    """Look up."""
    return f"TOOL-RESULT-{q} " + "row " * 200


@tool
def ask(q: str) -> str:
    """Ask the user."""
    return str(interrupt({"question": q}))


@tool
def broken(q: str) -> str:
    """Fail."""
    raise RuntimeError("tool exploded")


@pytest.fixture
def traced():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    key = f"pk-lf-{uuid.uuid4()}"
    client = Langfuse(
        public_key=key, secret_key="sk-lf-test", base_url="http://127.0.0.1:1", tracer_provider=provider
    )
    provider._active_span_processor._span_processors = ()  # no network export
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield key, exporter, provider
    client.shutdown()


def _messages() -> list:
    return [
        HumanMessage("earlier question " * 300),
        AIMessage("earlier answer " * 300),
        HumanMessage(content=[
            {"type": "text", "text": QUESTION},
            {"type": "file", "base64": FILE_B64, "mime_type": "application/pdf", "filename": "bundle.pdf"},
        ]),
    ]


def _agent(model, tools, **kwargs):
    return create_agent(model=model, tools=tools, middleware=[Hooks(), TodoListMiddleware()], **kwargs)


def _run(traced, handler_cls, model=None, tools=(look_up,), messages=None):
    key, exporter, provider = traced
    exporter.clear()
    model = model or ScriptedModel(seen=[])
    handler = handler_cls(public_key=key)
    # FastAPI's request span is the OpenTelemetry root in production.
    with provider.get_tracer("fastapi").start_as_current_span("POST /chat/stream"):
        result = _agent(model, list(tools)).invoke(
            {"messages": messages or _messages()}, config={"callbacks": [handler], "run_name": "helpudoc.general-assistant:fast"}
        )
    return exporter.get_finished_spans(), result, model


def _attr(span, name: str) -> Any:
    raw = (span.attributes or {}).get(name)
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _of_type(spans, kind: str) -> list:
    return [s for s in spans if _attr(s, "langfuse.observation.type") == kind]


def _bytes(spans) -> int:
    return sum(len(v) for s in spans for v in (s.attributes or {}).values() if isinstance(v, str))


def _root(spans):
    return next(s for s in spans if s.name == "helpudoc.general-assistant:fast")


def test_trace_shows_the_users_message_and_the_answer(traced):
    spans, _, _ = _run(traced, TrimmedLangfuseHandler)
    root = _root(spans)
    assert QUESTION in json.dumps(_attr(root, "langfuse.trace.input"))
    assert _attr(root, "langfuse.trace.output") == ANSWER
    assert _attr(root, "langfuse.trace.name") == "helpudoc.general-assistant:fast"
    assert _attr(root, "langfuse.observation.output") == ANSWER
    # The stock handler leaves the trace empty, which is what Langfuse showed.
    stock, _, _ = _run(traced, CallbackHandler)
    assert _attr(_root(stock), "langfuse.trace.input") is None


def test_model_and_tool_calls_are_complete(traced):
    spans, _, model = _run(traced, TrimmedLangfuseHandler)
    generations = _of_type(spans, "generation")
    assert len(generations) == STEPS + 1 == len(model.seen)
    for index, generation in enumerate(generations):
        prompt = json.dumps(_attr(generation, "langfuse.observation.input"))
        assert QUESTION in prompt and "earlier question" in prompt
        for done in range(index):
            assert f"TOOL-RESULT-q{done}" in prompt
    assert "look_up" in json.dumps(_attr(generations[0], "langfuse.observation.output"))
    assert ANSWER in json.dumps(_attr(generations[-1], "langfuse.observation.output"))
    tools = _of_type(spans, "tool")
    assert len(tools) == STEPS
    for index, span in enumerate(tools):
        assert f"q{index}" in json.dumps(_attr(span, "langfuse.observation.input"))
        assert f"TOOL-RESULT-q{index}" in json.dumps(_attr(span, "langfuse.observation.output"))


def test_same_spans_without_duplicate_state(traced):
    stock, _, _ = _run(traced, CallbackHandler)
    trimmed, _, _ = _run(traced, TrimmedLangfuseHandler)
    assert sorted(s.name for s in trimmed) == sorted(s.name for s in stock)
    for span in trimmed:
        if span.name != "helpudoc.general-assistant:fast" and span not in _of_type(trimmed, "generation"):
            assert QUESTION not in json.dumps(_attr(span, "langfuse.observation.input"))
    assert _bytes(trimmed) < _bytes(stock) * 0.05


def test_nested_spans_are_small_for_a_text_only_run(traced):
    messages = [HumanMessage("earlier question " * 3000), AIMessage("a " * 9000), HumanMessage(QUESTION)]
    stock, _, _ = _run(traced, CallbackHandler, messages=messages)
    trimmed, _, _ = _run(traced, TrimmedLangfuseHandler, messages=messages)
    assert _bytes(trimmed) < _bytes(stock) * 0.35


def test_files_become_a_fingerprint_and_the_model_still_gets_the_file(traced):
    spans, result, model = _run(traced, TrimmedLangfuseHandler)
    everything = "".join(str(v) for s in spans for v in (s.attributes or {}).values())
    assert FILE_B64[:400] not in everything
    assert FILE_SHA in everything and str(len(FILE)) in everything and "bundle.pdf" in everything
    for seen in model.seen:
        assert any(isinstance(m, HumanMessage) and isinstance(m.content, list) and m.content[1]["base64"] == FILE_B64 for m in seen)
    assert result["messages"][2].content[1]["base64"] == FILE_B64


def test_waiting_for_the_user_and_the_resume_are_visible(traced):
    key, exporter, _ = traced
    exporter.clear()
    agent = _agent(ScriptedModel(seen=[], tool_name="ask", steps=1), [ask], checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "t"}, "run_name": "helpudoc.general-assistant:fast"}
    agent.invoke({"messages": _messages()}, config={**config, "callbacks": [TrimmedLangfuseHandler(public_key=key)]})
    assert _attr(_root(exporter.get_finished_spans()), "langfuse.trace.output")["status"] in {
        "waiting for the user", "ended on tool calls",
    }
    exporter.clear()
    agent.invoke(Command(resume="Use the November file"), config={**config, "callbacks": [TrimmedLangfuseHandler(public_key=key)]})
    root = _root(exporter.get_finished_spans())
    assert _attr(root, "langfuse.trace.input") == {"resume": "Use the November file"}
    assert _attr(root, "langfuse.trace.output") == ANSWER


def test_a_failed_run_records_the_error(traced):
    key, exporter, _ = traced
    exporter.clear()
    agent = _agent(ScriptedModel(seen=[], tool_name="broken", steps=1), [broken])
    with pytest.raises(RuntimeError):
        agent.invoke({"messages": _messages()}, config={
            "callbacks": [TrimmedLangfuseHandler(public_key=key)], "run_name": "helpudoc.general-assistant:fast",
        })
    output = _attr(_root(exporter.get_finished_spans()), "langfuse.trace.output")
    assert output["status"] == "failed" and "tool exploded" in output["error"]


def test_a_direct_model_call_has_trace_input_and_output(traced):
    key, exporter, _ = traced
    exporter.clear()
    ScriptedModel(seen=[], steps=0).invoke(
        [HumanMessage("analyse this")],
        config={"callbacks": [TrimmedLangfuseHandler(public_key=key)], "run_name": "internal-analysis:user-memory"},
    )
    span = exporter.get_finished_spans()[0]
    assert _attr(span, "langfuse.trace.input") == "analyse this"
    assert _attr(span, "langfuse.trace.output") == ANSWER


def test_streaming_records_the_same_trace(traced):
    import asyncio

    key, exporter, _ = traced
    exporter.clear()

    async def go():
        stream = _agent(ScriptedModel(seen=[]), [look_up]).astream_events(
            {"messages": _messages()}, version="v2",
            config={"callbacks": [TrimmedLangfuseHandler(public_key=key)], "run_name": "helpudoc.general-assistant:fast"},
        )
        async for _event in stream:
            pass

    asyncio.run(go())
    root = _root(exporter.get_finished_spans())
    assert QUESTION in json.dumps(_attr(root, "langfuse.trace.input"))
    assert _attr(root, "langfuse.trace.output") == ANSWER


def test_redaction_leaves_text_alone_and_does_not_mutate():
    original = {"text": "base64 is a word", "data": "x" * 900, "items": [{"mime_type": "image/png", "data": FILE_B64}]}
    out = redact_files(original)
    assert out["text"] == original["text"] and out["data"] == original["data"]
    assert out["items"][0]["omitted_from_trace"]["sha256"] == FILE_SHA
    assert original["items"][0]["data"] == FILE_B64
    url = redact_files(f"see data:image/png;base64,{FILE_B64} end")
    assert FILE_SHA in url and url.endswith(" end") and len(url) < 250


def test_chat_output_is_identical_with_any_tracing(traced, monkeypatch):
    """What the user sees must not depend on the handler, even when the handler fails."""
    import asyncio

    key, _, _ = traced

    class Broken(TrimmedLangfuseHandler):
        def on_chain_start(self, *args, **kwargs):
            raise RuntimeError("handler failure")

        on_chat_model_start = on_chain_end = on_tool_end = on_llm_end = on_chain_start

    async def events(callbacks):
        model, out = ScriptedModel(seen=[]), []
        stream = _agent(model, [look_up]).astream_events(
            {"messages": _messages()}, version="v2", config={"callbacks": callbacks}
        )
        async for event in stream:
            data = event["data"].get("output")
            text = [m.content for m in data["messages"]] if isinstance(data, dict) and "messages" in data else None
            out.append((event["event"], event["name"], str(text)))
        return out, [[(m.type, str(m.content)) for m in seen] for seen in model.seen]

    plain = asyncio.run(events([]))
    for handler in (CallbackHandler(public_key=key), TrimmedLangfuseHandler(public_key=key), Broken(public_key=key)):
        assert asyncio.run(events([handler])) == plain
