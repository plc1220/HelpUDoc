"""Internal analysis must reach Langfuse as a model call, named by its purpose.

Chat runs pass the Langfuse callback; /internal/analyze did not, so the memory,
daily-reflection and skill-evolution model calls left no prompt, output, tokens
or cost in Langfuse -- only the HTTP request spans.
"""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from helpudoc_agent.api.routes import internal


class _Model:
    def __init__(self):
        self.calls = []

    async def ainvoke(self, messages, config=None):
        self.calls.append(config)
        return AIMessage(content="ok")


def _client(monkeypatch, callbacks):
    model = _Model()
    monkeypatch.setattr(internal, "require_internal_user_context", lambda request, agent_jwt_secret: {"user_id": "user-1"})
    monkeypatch.setattr(internal, "langfuse_langchain_callbacks", lambda: list(callbacks))
    app = FastAPI()
    internal.register_internal_routes(
        app,
        settings=SimpleNamespace(model=SimpleNamespace(resolve_chat_model_name=lambda mode: "fast-model")),
        registry=SimpleNamespace(_get_model=lambda name: model),
        memory_store_manager=None,
        agent_jwt_secret="x",
    )
    return TestClient(app), model


def test_analysis_runs_with_the_langfuse_callback_named_by_purpose(monkeypatch):
    handler = object()
    client, model = _client(monkeypatch, [handler])
    res = client.post("/internal/analyze", json={"systemPrompt": "s", "userPrompt": "u", "purpose": "User-Memory"})
    assert res.status_code == 200 and res.json() == {"text": "ok"}
    config = model.calls[0]
    assert config["callbacks"] == [handler]
    assert config["run_name"] == "internal-analysis:user-memory"
    assert config["metadata"] == {"langfuse_tags": ["internal-analysis"], "langfuse_user_id": "user-1"}


def test_analysis_without_purpose_or_langfuse_still_works(monkeypatch):
    client, model = _client(monkeypatch, [])
    res = client.post("/internal/analyze", json={"systemPrompt": "s", "userPrompt": "u"})
    assert res.status_code == 200
    assert model.calls[0]["run_name"] == "internal-analysis"
    assert "callbacks" not in model.calls[0]
