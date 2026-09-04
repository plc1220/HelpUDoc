"""Regression: agent spans reach GCP independently of Langfuse.

Langfuse was the only destination for trace data, so spans were lost whenever
``langfuse-web`` was down. ``configure_tracing`` installs a second export path.
These tests pin the properties that make it durable and safe.
"""

import json
import logging

import pytest

from helpudoc_agent.logging_setup import configure_logging, reset_logging_for_tests
from helpudoc_agent.tracing_setup import (
    SpanLogProcessor,
    configure_tracing,
    reset_tracing_for_tests,
)


@pytest.fixture(autouse=True)
def clean_otel_state():
    reset_tracing_for_tests()
    yield
    reset_tracing_for_tests()


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("GCP_TRACE_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")


def _finished_span(tracer, name="run", attributes=None):
    with tracer.start_as_current_span(name, attributes=attributes or {}):
        pass


def _entries(capsys):
    out, _ = capsys.readouterr()
    return [json.loads(line) for line in out.splitlines() if line.strip()]


@pytest.fixture
def json_logs(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "INFO")
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    reset_logging_for_tests()
    configure_logging(force=True)
    yield capsys
    reset_logging_for_tests()
    root.handlers = saved_handlers
    root.setLevel(saved_level)
    logging.captureWarnings(False)


def test_disabled_by_default_installs_nothing(monkeypatch):
    monkeypatch.delenv("GCP_TRACE_ENABLED", raising=False)
    from opentelemetry import trace as otel

    assert configure_tracing() is None
    # Still the proxy, so Langfuse sets up its own provider exactly as before.
    assert isinstance(otel.get_tracer_provider(), otel.ProxyTracerProvider)


def test_span_is_logged_with_cloud_trace_correlation(enabled, json_logs):
    provider = configure_tracing(force=True)
    _finished_span(provider.get_tracer(__name__), "agent.run")
    provider.force_flush()

    entry = next(e for e in _entries(json_logs) if e.get("spanName") == "agent.run")
    assert entry["logging.googleapis.com/trace"].startswith("projects/test-project/traces/")
    # 32 hex chars, or the console will not resolve the span.
    assert len(entry["logging.googleapis.com/trace"].rsplit("/", 1)[1]) == 32
    assert len(entry["logging.googleapis.com/spanId"]) == 16
    assert entry["durationMs"] >= 0
    assert entry["spanStatus"] == "UNSET"


def test_payload_bodies_are_excluded_by_default(enabled, json_logs):
    provider = configure_tracing(force=True)
    _finished_span(
        provider.get_tracer(__name__),
        "generation",
        {
            "langfuse.observation.input": "secret prompt text",
            "gen_ai.usage.input_tokens": 42,
            "gen_ai.request.model": "gemini-3.5-flash",
        },
    )
    provider.force_flush()

    entry = next(e for e in _entries(json_logs) if e.get("spanName") == "generation")
    assert "langfuse.observation.input" not in entry
    assert entry["gen_ai.usage.input_tokens"] == 42
    assert entry["gen_ai.request.model"] == "gemini-3.5-flash"


def test_payload_bodies_are_truncated_when_enabled(monkeypatch, enabled, json_logs):
    monkeypatch.setenv("GCP_TRACE_INCLUDE_PAYLOADS", "true")
    provider = configure_tracing(force=True)
    _finished_span(
        provider.get_tracer(__name__),
        "generation",
        {"langfuse.observation.output": "x" * 20000},
    )
    provider.force_flush()

    entry = next(e for e in _entries(json_logs) if e.get("spanName") == "generation")
    body = entry["langfuse.observation.output"]
    assert body.endswith("[truncated]")
    # Must stay well under the 256 KiB Cloud Logging entry limit.
    assert len(body) < 5000


def test_unknown_attributes_are_dropped(enabled, json_logs):
    provider = configure_tracing(force=True)
    _finished_span(provider.get_tracer(__name__), "run", {"internal.debug.blob": "noise"})
    provider.force_flush()

    entry = next(e for e in _entries(json_logs) if e.get("spanName") == "run")
    assert "internal.debug.blob" not in entry


def test_configure_tracing_is_idempotent(enabled):
    first = configure_tracing()
    assert configure_tracing() is first
    assert configure_tracing() is first


def test_sample_ratio_installs_a_sampler(monkeypatch, enabled):
    from opentelemetry.sdk.trace.sampling import ParentBased

    monkeypatch.setenv("GCP_TRACE_SAMPLE_RATIO", "0.25")
    provider = configure_tracing(force=True)
    assert isinstance(provider.sampler, ParentBased)


def test_missing_project_still_logs_the_span(monkeypatch, json_logs):
    monkeypatch.setenv("GCP_TRACE_ENABLED", "true")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("GCLOUD_PROJECT", raising=False)

    provider = configure_tracing(force=True)
    _finished_span(provider.get_tracer(__name__), "run")
    provider.force_flush()

    entry = next(e for e in _entries(json_logs) if e.get("spanName") == "run")
    # Degrades to a bare trace id rather than emitting an unresolvable field.
    assert "logging.googleapis.com/trace" not in entry
    assert len(entry["traceId"]) == 32


def test_logging_failure_does_not_break_the_span_pipeline(monkeypatch):
    processor = SpanLogProcessor("p")
    monkeypatch.setattr(
        "helpudoc_agent.tracing_setup.span_logger.info",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("logging is down")),
    )

    class _Span:
        name = "run"

        def get_span_context(self):
            raise RuntimeError("boom")

    processor.on_end(_Span())  # must not raise


def test_langfuse_attaches_to_our_provider(enabled):
    """The ordering guarantee the whole design rests on.

    langfuse._client.resource_manager._init_tracer_provider only builds its own
    provider when the global one is still a ProxyTracerProvider; otherwise it
    reuses what is installed. If that ever changes, GCP export silently stops
    receiving spans, so assert it directly against the installed SDK.
    """
    pytest.importorskip("langfuse")
    from opentelemetry import trace as otel
    from langfuse._client.resource_manager import _init_tracer_provider

    ours = configure_tracing(force=True)
    before = len(ours._active_span_processor._span_processors)

    langfuse_provider = _init_tracer_provider()

    assert langfuse_provider is ours, "Langfuse replaced our TracerProvider"
    assert otel.get_tracer_provider() is ours
    langfuse_provider.add_span_processor(SpanLogProcessor("p"))
    assert len(ours._active_span_processor._span_processors) == before + 1
