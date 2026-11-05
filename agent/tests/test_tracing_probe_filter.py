"""Health-check requests must not become traces.

FastAPI 0.16x traces every request itself once a TracerProvider exists, so each
Kubernetes probe became a Langfuse trace: about 8,000 a day on aria-dev, burying
the chat traces and filling MinIO with raw events.
"""
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON, Decision

from helpudoc_agent import tracing_setup
from helpudoc_agent.tracing_setup import ProbeFilterSampler

PROBES = frozenset({"/health", "/ready"})


def _decision(name, attributes=None, excluded=PROBES):
    return ProbeFilterSampler(ALWAYS_ON, excluded).should_sample(None, 1, name, attributes=attributes).decision


@pytest.mark.parametrize("name, attributes", [
    ("GET /ready", None),
    ("GET /health", None),
    ("GET", {"url.path": "/ready"}),
    ("GET /x", {"http.route": "/health"}),
    ("GET /ready?probe=1", None),
])
def test_probe_requests_are_dropped(name, attributes):
    assert _decision(name, attributes) == Decision.DROP


@pytest.mark.parametrize("name", [
    "POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream",
    "POST /knowledge/ingestion/map",
    "GET /agents",
    "ChatGoogleGenerativeAI",          # LangChain/Langfuse spans, not HTTP requests
    "LangGraph",
])
def test_user_and_agent_spans_are_kept(name):
    assert _decision(name) == Decision.RECORD_AND_SAMPLE


def test_an_empty_list_traces_everything():
    assert _decision("GET /ready", excluded=frozenset()) == Decision.RECORD_AND_SAMPLE


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.delenv("GCP_TRACE_ENABLED", raising=False)
    monkeypatch.delenv("TRACE_EXCLUDED_PATHS", raising=False)
    tracing_setup.reset_tracing_for_tests()
    provider = tracing_setup.configure_tracing(force=True)
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))   # stands in for Langfuse's processor
    yield provider, exporter
    tracing_setup.reset_tracing_for_tests()


def test_filtering_provider_is_installed_without_gcp_export(provider):
    provider, exporter = provider
    assert trace.get_tracer_provider() is provider
    tracer = trace.get_tracer("test")
    with tracer.start_as_current_span("GET /ready"):
        with tracer.start_as_current_span("fastapi.endpoint"):    # child of a dropped probe
            pass
    with tracer.start_as_current_span("POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream"):
        with tracer.start_as_current_span("fastapi.endpoint"):
            pass
    names = [s.name for s in exporter.get_finished_spans()]
    assert names == ["fastapi.endpoint", "POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream"]


def test_fastapi_native_request_spans_skip_probes(provider):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    provider, exporter = provider
    app = fastapi.FastAPI()

    @app.get("/ready")
    def ready():
        return {"ok": True}

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream")
    def chat(agent_name: str, workspace_id: str):
        return {"ok": True}

    client = TestClient(app)
    client.get("/ready")
    client.get("/health")
    client.post("/agents/fast/workspace/w1/chat/stream")
    spans = exporter.get_finished_spans()
    if not spans:
        pytest.skip(f"FastAPI {fastapi.__version__} does not trace requests itself")
    roots = [s.name for s in spans if s.parent is None]
    assert roots == ["POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream"]
    assert not any((s.attributes or {}).get("url.path") in PROBES for s in spans)
