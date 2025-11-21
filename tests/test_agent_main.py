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


class MCPServerRegistryStub:
    def __init__(self, *_, **__):
        pass

    def describe(self):
        return []


class RegistryStub:
    instance = None

    def __init__(self, *_, **__):
        self.runtimes = {}
        RegistryStub.instance = self

    def set_runtime(self, agent_name: str, workspace_id: str, runtime):
        self.runtimes[(agent_name, workspace_id)] = runtime

    def get_or_create(self, agent_name: str, workspace_id: str):
        key = (agent_name, workspace_id)
        if key not in self.runtimes:
            raise ValueError(f"Unknown runtime for {agent_name}/{workspace_id}")
        return self.runtimes[key]


class DummyRuntime:
    def __init__(self, workspace_id: str, agent):
        self.agent = agent
        self.workspace_state = SimpleNamespace(workspace_id=workspace_id)


class StreamingAgent:
    def __init__(self, messages):
        self._messages = messages

    async def astream(self, *_args, **_kwargs):
        for text in self._messages:
            yield ("messages", ({"role": "assistant", "content": text}, {"node": "test"}))


def _collect_stream_payloads(response):
    payloads = []
    for line in response.iter_lines():
        if not line:
            continue
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        payloads.append(json.loads(line))
    return payloads


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

        def _tool(fn):
            return fn

        tools_module.Tool = _Tool
        tools_module.tool = _tool
        sys.modules["langchain_core.tools"] = tools_module
        langchain_core.tools = tools_module

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

        class _Client:
            def __init__(self, *_, **__):
                pass

        genai.Client = _Client
        sys.modules["google.genai"] = genai
        google_pkg.genai = genai


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

    graph_stub = ModuleType("helpudoc_agent.graph")
    graph_stub.AgentRegistry = RegistryStub
    sys.modules["helpudoc_agent.graph"] = graph_stub

    tools_stub = ModuleType("helpudoc_agent.tools_and_schemas")
    tools_stub.ToolFactory = ToolFactoryStub
    tools_stub.GeminiClientManager = GeminiClientManagerStub
    tools_stub.MCPServerRegistry = MCPServerRegistryStub
    sys.modules["helpudoc_agent.tools_and_schemas"] = tools_stub

    import helpudoc_agent.app as app_module

    # Reset singleton references for each test run.
    RegistryStub.instance = None
    SourceTrackerStub.instance = None

    monkeypatch.setattr(app_module, "load_settings", lambda: SettingsStub())
    monkeypatch.setattr(app_module, "PromptStore", PromptStoreStub)
    monkeypatch.setattr(app_module, "SourceTracker", SourceTrackerStub)
    monkeypatch.setattr(app_module, "GeminiClientManager", GeminiClientManagerStub)
    monkeypatch.setattr(app_module, "ToolFactory", ToolFactoryStub)
    monkeypatch.setattr(app_module, "AgentRegistry", RegistryStub)
    monkeypatch.setattr(app_module, "MCPServerRegistry", MCPServerRegistryStub)

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

    assert [m["type"] for m in messages] == ["token", "token", "done"]
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
