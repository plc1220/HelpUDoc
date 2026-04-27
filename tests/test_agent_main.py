import json
import sys
from types import ModuleType, SimpleNamespace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure the repository root (which contains the `agent` package) is importable.
CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


class SettingsStub:
    """Minimal settings object used by the FastAPI app during tests."""

    mcp_servers = {}
    tools = {}
    backend = SimpleNamespace(
        workspace_root=Path("/tmp/helpudoc-agent-tests"),
        skills_root=None,
    )

    def list_agents(self):
        return []


class PromptStoreStub:  # pragma: no cover - simple placeholder
    def __init__(self):
        self.loaded = []


class SourceTrackerStub:
    instance = None

    def __init__(self):
        self.updated_workspaces = []
        SourceTrackerStub.instance = self

    def update_final_report(self, workspace_state):
        self.updated_workspaces.append(workspace_state)


class GeminiClientManagerStub:  # pragma: no cover - placeholder for dependency
    def __init__(self, *_, **__):
        pass


class ToolFactoryStub:  # pragma: no cover - placeholder for dependency
    def __init__(self, *_, **__):
        pass


class RagWorkerStoreStub:
    next_response = {"data": {"chunks": []}}

    def __init__(self):
        self.query_data_calls = []

    async def query_data(self, *args, **kwargs):
        self.query_data_calls.append((args, kwargs))
        return RagWorkerStoreStub.next_response


class RagIndexWorkerStub:
    last_instance = None

    def __init__(self, *_args, **_kwargs):
        self.store = RagWorkerStoreStub()
        RagIndexWorkerStub.last_instance = self

    async def start(self):
        return None

    async def stop(self):
        return None


class RegistryStub:
    instance = None

    def __init__(self, *_, **__):
        self.runtimes = {}
        RegistryStub.instance = self

    def set_runtime(self, agent_name: str, workspace_id: str, runtime):
        self.runtimes[(agent_name, workspace_id)] = runtime

    async def get_or_create(self, agent_name: str, workspace_id: str, initial_context=None):
        key = (agent_name, workspace_id)
        if key not in self.runtimes:
            raise ValueError(f"Unknown runtime for {agent_name}/{workspace_id}")
        return self.runtimes[key]


class DummyRuntime:
    def __init__(self, workspace_id: str, agent):
        self.agent = agent
        self.agent_name = "test-agent"
        self.workspace_state = SimpleNamespace(workspace_id=workspace_id, context={})


class StreamingAgent:
    def __init__(self, messages):
        self._messages = messages

    async def astream(self, *_args, **_kwargs):
        accumulated = ""
        for message in self._messages:
            accumulated += message
            yield {"messages": [{"role": "assistant", "content": accumulated}]}

    async def ainvoke(self, *_args, **_kwargs):
        return {
            "messages": [
                {"role": "assistant", "content": "".join(self._messages)}
            ]
        }


class AsyncInvokeAgent:
    def __init__(self, reply):
        self._reply = reply

    async def ainvoke(self, *_args, **_kwargs):
        return self._reply


def _collect_stream_payloads(response):
    payloads = []
    for line in response.iter_lines():
        if not line:
            continue
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        payloads.append(json.loads(line))
    return payloads


def test_host_datetime_context_is_injected_as_system_message(client_with_stubs):
    client_with_stubs
    import helpudoc_agent.app as app_module

    payload = [{"role": "user", "content": "What is today's date?"}]

    app_module._inject_host_datetime_context(payload)

    assert payload[0]["role"] == "system"
    assert "[Host time]" in payload[0]["content"]
    assert "Authoritative local date:" in payload[0]["content"]
    assert payload[1]["role"] == "user"
    assert "What is today's date?" in payload[1]["content"]


def test_tagged_file_rag_only_disabled_when_preferred_mcp_is_set(client_with_stubs):
    client_with_stubs
    import helpudoc_agent.app as app_module

    assert app_module._should_force_tagged_files_rag_only(
        env_tagged_files_rag_only=False,
        explicit_artifact_paths=["/.system/derived-artifacts/doc/v1.md"],
        message_content=None,
        preferred_mcp_server="gcp-cost",
        prompt_for_tagged_files="check /mcp gcp-cost if necessary",
    ) is False


def test_tagged_file_rag_only_disabled_for_freshness_requests(client_with_stubs):
    client_with_stubs
    import helpudoc_agent.app as app_module

    assert app_module._should_force_tagged_files_rag_only(
        env_tagged_files_rag_only=False,
        explicit_artifact_paths=["/.system/derived-artifacts/doc/v1.md"],
        message_content=None,
        preferred_mcp_server=None,
        prompt_for_tagged_files="review this and verify the latest Gemini pricing including thinking tokens",
    ) is False


def test_tagged_file_rag_only_remains_enabled_for_normal_artifact_only_turns(client_with_stubs):
    client_with_stubs
    import helpudoc_agent.app as app_module

    assert app_module._should_force_tagged_files_rag_only(
        env_tagged_files_rag_only=False,
        explicit_artifact_paths=["/.system/derived-artifacts/doc/v1.md"],
        message_content=None,
        preferred_mcp_server=None,
        prompt_for_tagged_files="update the attached proposal section",
    ) is True


def _install_dependency_stubs():
    """Install lightweight stand-ins for heavy optional dependencies."""

    def _ensure_module(name: str) -> ModuleType:
        module = ModuleType(name)
        module.__dict__.setdefault("__path__", [])
        sys.modules[name] = module
        return module

    if "deepagents" not in sys.modules:
        deepagents = _ensure_module("deepagents")

        class _DummyAgent:
            def invoke(self, *_args, **_kwargs):
                return {}

            async def astream(self, *_args, **_kwargs):
                if False:  # pragma: no cover - keeps generator async
                    yield None

        def _create_deep_agent(*_args, **_kwargs):
            return _DummyAgent()

        deepagents.create_deep_agent = _create_deep_agent

        backends = ModuleType("deepagents.backends")

        class _FilesystemBackend:
            def __init__(self, *_args, **_kwargs):
                pass

        backends.FilesystemBackend = _FilesystemBackend
        sys.modules["deepagents.backends"] = backends
        deepagents.backends = backends

        middleware_pkg = ModuleType("deepagents.middleware")
        filesystem_middleware = ModuleType("deepagents.middleware.filesystem")

        class _FilesystemMiddleware:
            def __init__(self, *_args, **_kwargs):
                pass

        filesystem_middleware.FilesystemMiddleware = _FilesystemMiddleware
        sys.modules["deepagents.middleware"] = middleware_pkg
        sys.modules["deepagents.middleware.filesystem"] = filesystem_middleware
        middleware_pkg.filesystem = filesystem_middleware
        deepagents.middleware = middleware_pkg

    if "langchain" not in sys.modules:
        langchain = _ensure_module("langchain")
    else:
        langchain = sys.modules["langchain"]

    if "langchain.chat_models" not in sys.modules:
        chat_models = ModuleType("langchain.chat_models")

        def _init_chat_model(*_args, **_kwargs):
            return object()

        chat_models.init_chat_model = _init_chat_model
        sys.modules["langchain.chat_models"] = chat_models
        langchain.chat_models = chat_models

    if "langchain_core" not in sys.modules:
        langchain_core = _ensure_module("langchain_core")
    else:
        langchain_core = sys.modules["langchain_core"]

    if "langchain_core.callbacks" not in sys.modules:
        callbacks_pkg = ModuleType("langchain_core.callbacks")
        sys.modules["langchain_core.callbacks"] = callbacks_pkg
    else:
        callbacks_pkg = sys.modules["langchain_core.callbacks"]

    if "langchain_core.callbacks.base" not in sys.modules:
        callbacks_base = ModuleType("langchain_core.callbacks.base")

        class _AsyncCallbackHandler:
            async def on_llm_new_token(self, *args, **kwargs):
                return None

            async def on_llm_end(self, *args, **kwargs):
                return None

            async def on_agent_action(self, *args, **kwargs):
                return None

            async def on_tool_start(self, *args, **kwargs):
                return None

            async def on_tool_end(self, *args, **kwargs):
                return None

            async def on_tool_error(self, *args, **kwargs):
                return None

            async def on_custom_event(self, *args, **kwargs):
                return None

        callbacks_base.AsyncCallbackHandler = _AsyncCallbackHandler
        sys.modules["langchain_core.callbacks.base"] = callbacks_base
        callbacks_pkg.base = callbacks_base
    if "langchain_core.tools" not in sys.modules:
        tools_module = ModuleType("langchain_core.tools")

        class _Tool:
            pass

        class _StructuredTool(_Tool):
            pass

        def _tool(fn):
            return fn

        tools_module.Tool = _Tool
        tools_module.StructuredTool = _StructuredTool
        tools_module.tool = _tool
        sys.modules["langchain_core.tools"] = tools_module
        langchain_core.tools = tools_module

    if "langgraph" not in sys.modules:
        langgraph_pkg = _ensure_module("langgraph")
    else:
        langgraph_pkg = sys.modules["langgraph"]

    if "langgraph.types" not in sys.modules:
        langgraph_types = ModuleType("langgraph.types")

        class _Command:
            def __init__(self, *_, **kwargs):
                self.kwargs = kwargs

        langgraph_types.Command = _Command
        sys.modules["langgraph.types"] = langgraph_types
        langgraph_pkg.types = langgraph_types

    if "langgraph.errors" not in sys.modules:
        langgraph_errors = ModuleType("langgraph.errors")

        class _GraphInterrupt(Exception):
            pass

        langgraph_errors.GraphInterrupt = _GraphInterrupt
        sys.modules["langgraph.errors"] = langgraph_errors
        langgraph_pkg.errors = langgraph_errors

    if "vertexai" not in sys.modules:
        vertexai = ModuleType("vertexai")

        def _init(*_args, **_kwargs):
            return None

        vertexai.init = _init
        sys.modules["vertexai"] = vertexai

    if "google" not in sys.modules:
        google_pkg = _ensure_module("google")
    else:
        google_pkg = sys.modules["google"]

    if "google.genai" not in sys.modules:
        genai = ModuleType("google.genai")
        genai_types = ModuleType("google.genai.types")

        class _Client:
            def __init__(self, *_, **__):
                pass

        class _Part:
            @staticmethod
            def from_bytes(*_args, **_kwargs):
                return {"kind": "bytes"}

        class _GenerateContentConfig:
            def __init__(self, *_, **__):
                pass

        genai.Client = _Client
        genai.types = genai_types
        genai_types.Part = _Part
        genai_types.GenerateContentConfig = _GenerateContentConfig
        sys.modules["google.genai"] = genai
        sys.modules["google.genai.types"] = genai_types
        google_pkg.genai = genai

    if "redis" not in sys.modules:
        redis_pkg = _ensure_module("redis")
    else:
        redis_pkg = sys.modules["redis"]

    if "redis.asyncio" not in sys.modules:
        redis_asyncio = ModuleType("redis.asyncio")

        class _Redis:  # pragma: no cover - placeholder
            def __init__(self, *_, **__):
                pass

        redis_asyncio.Redis = _Redis
        sys.modules["redis.asyncio"] = redis_asyncio
        redis_pkg.asyncio = redis_asyncio

    if "paper2slides" not in sys.modules:
        paper2slides_pkg = _ensure_module("paper2slides")
    else:
        paper2slides_pkg = sys.modules["paper2slides"]

    if "paper2slides.raganything" not in sys.modules:
        raganything_pkg = ModuleType("paper2slides.raganything")
        raganything_pkg.__dict__.setdefault("__path__", [])
        sys.modules["paper2slides.raganything"] = raganything_pkg
        paper2slides_pkg.raganything = raganything_pkg
    else:
        raganything_pkg = sys.modules["paper2slides.raganything"]

    if "paper2slides.raganything.parser" not in sys.modules:
        rag_parser = ModuleType("paper2slides.raganything.parser")

        class _DoclingParser:
            def __init__(self, *_args, **_kwargs):
                pass

        rag_parser.DoclingParser = _DoclingParser
        sys.modules["paper2slides.raganything.parser"] = rag_parser
        raganything_pkg.parser = rag_parser


@pytest.fixture
def client_with_stubs(monkeypatch):
    module_names = [
        "agent.main",
        "helpudoc_agent.app",
        "helpudoc_agent.graph",
        "helpudoc_agent.tools_and_schemas",
    ]
    saved_modules = {name: sys.modules.pop(name, None) for name in module_names}

    _install_dependency_stubs()
    monkeypatch.setenv("RAG_PARSER_PIPELINE", "stub")
    monkeypatch.setenv("RAGANYTHING_PARSER", "stub")
    monkeypatch.setenv("PARSER_ENRICHMENT_MODE", "stub")

    graph_stub = ModuleType("helpudoc_agent.graph")
    graph_stub.AgentRegistry = RegistryStub
    sys.modules["helpudoc_agent.graph"] = graph_stub

    tools_stub = ModuleType("helpudoc_agent.tools_and_schemas")
    tools_stub.ToolFactory = ToolFactoryStub
    tools_stub.GeminiClientManager = GeminiClientManagerStub
    sys.modules["helpudoc_agent.tools_and_schemas"] = tools_stub

    import helpudoc_agent.app as app_module

    # Reset singleton references for each test run.
    RegistryStub.instance = None
    SourceTrackerStub.instance = None

    monkeypatch.setattr(app_module, "load_settings", lambda *_args, **_kwargs: SettingsStub())
    monkeypatch.setattr(app_module, "SourceTracker", SourceTrackerStub)
    monkeypatch.setattr(app_module, "GeminiClientManager", GeminiClientManagerStub)
    monkeypatch.setattr(app_module, "ToolFactory", ToolFactoryStub)
    monkeypatch.setattr(app_module, "AgentRegistry", RegistryStub)
    monkeypatch.setattr(app_module, "RagIndexWorker", RagIndexWorkerStub)

    import agent.main as agent_main

    client = TestClient(agent_main.app)
    registry = RegistryStub.instance
    source_tracker = SourceTrackerStub.instance
    assert registry is not None, "Registry stub was not initialized"
    assert source_tracker is not None, "Source tracker stub was not initialized"

    try:
        yield client, registry, source_tracker
    finally:
        client.close()
        sys.modules.pop("helpudoc_agent.graph", None)
        sys.modules.pop("helpudoc_agent.tools_and_schemas", None)
        for name, module in saved_modules.items():
            if module is not None:
                sys.modules[name] = module
            elif name not in ("helpudoc_agent.graph", "helpudoc_agent.tools_and_schemas"):
                sys.modules.pop(name, None)


def test_chat_stream_emits_tokens_and_done(client_with_stubs):
    client, registry, source_tracker = client_with_stubs
    runtime = DummyRuntime("workspace-123", StreamingAgent(["Hello ", "world!"]))
    registry.set_runtime("research", "workspace-123", runtime)

    payload = {"message": "hi", "history": []}
    with client.stream("POST", "/agents/research/workspace/workspace-123/chat/stream", json=payload) as response:
        assert response.status_code == 200
        messages = _collect_stream_payloads(response)

    assert messages[-1]["type"] == "done"
    assert "".join(m["content"] for m in messages if m["type"] == "token") == "Hello world!"
    assert source_tracker.updated_workspaces == [runtime.workspace_state]


def test_chat_stream_returns_error_when_agent_missing(client_with_stubs):
    client, registry, source_tracker = client_with_stubs
    runtime = DummyRuntime("workspace-abc", agent=None)
    registry.set_runtime("research", "workspace-abc", runtime)

    payload = {"message": "hi"}
    with client.stream("POST", "/agents/research/workspace/workspace-abc/chat/stream", json=payload) as response:
        assert response.status_code == 200
        messages = _collect_stream_payloads(response)

    assert messages == [{"type": "error", "message": "Agent not initialized"}]
    assert source_tracker.updated_workspaces == []


def test_chat_stream_returns_404_for_unknown_agent(client_with_stubs):
    client, registry, _ = client_with_stubs
    payload = {"message": "hi"}
    response = client.post("/agents/ghost/workspace/workspace-999/chat/stream", json=payload)

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown runtime for ghost/workspace-999"


def test_chat_uses_async_invoke_for_async_only_agents(client_with_stubs):
    client, registry, source_tracker = client_with_stubs
    runtime = DummyRuntime("workspace-async", AsyncInvokeAgent({"messages": [{"role": "assistant", "content": "ok"}]}))
    registry.set_runtime("research", "workspace-async", runtime)

    response = client.post("/agents/research/workspace/workspace-async/chat", json={"message": "hi"})

    assert response.status_code == 200
    assert response.json()["reply"] == {"messages": [{"role": "assistant", "content": "ok"}]}
    assert source_tracker.updated_workspaces == [runtime.workspace_state]


def test_format_exception_flattens_exception_groups(client_with_stubs):
    client_with_stubs  # ensure dependency stubs are installed before import

    import helpudoc_agent.app as app_module

    error = ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError("401 Unauthorized"), ValueError("bad args")])

    assert app_module._format_exception(error) == "401 Unauthorized; bad args"


def test_extract_directive_from_text_supports_use_skill_prefix(client_with_stubs):
    client_with_stubs

    import helpudoc_agent.app as app_module

    directive, prompt = app_module._extract_directive_from_text(
        "Use /skill proposal-writing draft a short proposal for Acme"
    )

    assert directive is not None
    assert directive.kind == "skill"
    assert directive.skillId == "proposal-writing"
    assert prompt == "draft a short proposal for Acme"


def test_extract_directive_from_text_supports_first_line_skill_command(client_with_stubs):
    client_with_stubs

    import helpudoc_agent.app as app_module

    directive, prompt = app_module._extract_directive_from_text(
        "/skill proposal-writing\nDraft a short proposal for Acme.\nFocus on timeline and budget."
    )

    assert directive is not None
    assert directive.kind == "skill"
    assert directive.skillId == "proposal-writing"
    assert prompt == "Draft a short proposal for Acme.\nFocus on timeline and budget."


def test_extract_directive_from_text_supports_use_mcp_prefix(client_with_stubs):
    client_with_stubs

    import helpudoc_agent.app as app_module

    directive, prompt = app_module._extract_directive_from_text(
        "Please use /mcp aws-knowledge find the latest AWS Bedrock guidance"
    )

    assert directive is not None
    assert directive.kind == "mcp"
    assert directive.serverId == "aws-knowledge"
    assert prompt == "find the latest AWS Bedrock guidance"


def test_append_tagged_file_guidance_warns_for_html(client_with_stubs):
    client_with_stubs

    import helpudoc_agent.app as app_module

    prompt = "Use /skill data/dashboard\n\nTagged files:\n- reports/order_cancellations_analysis.html\n- datasets/order_cancellations_6m.parquet"
    guided = app_module._append_tagged_file_guidance(
        prompt,
        ["reports/order_cancellations_analysis.html", "datasets/order_cancellations_6m.parquet"],
    )

    assert "Tagged file guidance:" in guided
    assert "Do not read an entire report HTML" in guided


def test_filter_rag_prefetchable_tagged_files_includes_html(client_with_stubs):
    client_with_stubs

    import helpudoc_agent.app as app_module

    filtered = app_module._filter_rag_prefetchable_tagged_files(
        ["reports/story.html", "reports/notes.md", "datasets/orders.parquet"]
    )
    assert "reports/story.html" in filtered
    assert "reports/notes.md" in filtered
    assert "datasets/orders.parquet" not in filtered


def test_extract_html_outline_from_path_strips_markup(client_with_stubs, tmp_path):
    client_with_stubs

    import helpudoc_agent.app as app_module

    html_path = tmp_path / "report.html"
    html_path.write_text(
        """
        <html>
          <head>
            <title>Order Cancellation Story</title>
            <style>.hidden { display:none; }</style>
            <script>console.log('ignore me');</script>
          </head>
          <body>
            <h1>Main Heading</h1>
            <h2>Drivers</h2>
            <p>Cancellation rates rose in Spain and Belgium.</p>
            <p>Mobile web contributed disproportionate losses.</p>
          </body>
        </html>
        """,
        encoding="utf-8",
    )

    outline = app_module._extract_html_outline_from_path(html_path, max_chars=400)
    assert outline is not None
    assert "TITLE: Order Cancellation Story" in outline
    assert "Main Heading" in outline
    assert "Drivers" in outline
    assert "Cancellation rates rose in Spain and Belgium." in outline
    assert "console.log" not in outline
    assert ".hidden" not in outline


def test_chat_stream_skips_rag_prefetch_for_tagged_parquet(client_with_stubs):
    client, registry, source_tracker = client_with_stubs
    runtime = DummyRuntime("workspace-parquet", StreamingAgent(["Clarify please"]))
    registry.set_runtime("research", "workspace-parquet", runtime)

    payload = {
        "message": "Use /skill data/dashboard to generate a dashboard\n\nTagged files:\n- datasets/order_cancellations_6m.parquet\n",
        "history": [],
    }
    with client.stream("POST", "/agents/research/workspace/workspace-parquet/chat/stream", json=payload) as response:
        assert response.status_code == 200
        messages = _collect_stream_payloads(response)

    rag_worker = RagIndexWorkerStub.last_instance
    assert rag_worker is not None
    assert rag_worker.store.query_data_calls == []
    assert messages[0]["type"] == "policy"
    assert messages[-1]["type"] == "done"
    assert source_tracker.updated_workspaces == [runtime.workspace_state]


def test_chat_stream_prefetches_tagged_html_with_scoped_keywords(client_with_stubs):
    client, registry, source_tracker = client_with_stubs
    RagWorkerStoreStub.next_response = {
        "data": {
            "chunks": [
                {"file_path": "/reports/order_cancellations_analysis.html", "content": "Story chunk"},
                {"file_path": "/reports/other.html", "content": "Ignore chunk"},
            ]
        }
    }
    runtime = DummyRuntime("workspace-html", StreamingAgent(["OK"]))
    registry.set_runtime("research", "workspace-html", runtime)

    payload = {
        "message": "Use /skill data/dashboard\n\nTagged files:\n- reports/order_cancellations_analysis.html\n",
        "history": [],
    }
    with client.stream("POST", "/agents/research/workspace/workspace-html/chat/stream", json=payload) as response:
        assert response.status_code == 200
        messages = _collect_stream_payloads(response)

    rag_worker = RagIndexWorkerStub.last_instance
    assert rag_worker is not None
    assert len(rag_worker.store.query_data_calls) >= 1
    _args, kwargs = rag_worker.store.query_data_calls[0]
    assert "/reports/order_cancellations_analysis.html" in kwargs["hl_keywords"]
    assert "order_cancellations_analysis.html" in kwargs["ll_keywords"]
    assert runtime.workspace_state.context["tagged_rag_context"] == "Story chunk"
    assert messages[-1]["type"] == "done"
    assert source_tracker.updated_workspaces == [runtime.workspace_state]
