"""Regression: HelpUDoc model settings map onto LangChain Google GenAI aliases."""

import pytest


def test_gemini_factory_maps_max_tokens_and_request_timeout(monkeypatch):
    from helpudoc_agent.configuration import ModelConfig
    from helpudoc_agent.gemini_chat import create_chat_google_generative_ai

    captured: dict = {}

    class DummyCtor:
        def __init__(self, **kwargs):
            captured.clear()
            captured.update(kwargs)

    monkeypatch.setattr("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI", DummyCtor)

    cfg = ModelConfig(provider="gemini", name="m", api_key="k", use_vertex_ai=False)
    create_chat_google_generative_ai(
        cfg,
        "gemini-demo",
        thinking_level=None,
        max_output_tokens=12345,
        timeout=61.25,
    )
    assert captured["model"] == "gemini-demo"
    assert captured["max_tokens"] == 12345
    assert captured["request_timeout"] == pytest.approx(61.25)
    assert "max_output_tokens" not in captured


def test_gemini_factory_vertex_uses_adc_not_api_key(monkeypatch):
    from helpudoc_agent.configuration import ModelConfig
    from helpudoc_agent.gemini_chat import create_chat_google_generative_ai

    captured: dict = {}
    init_calls: list = []

    class DummyCtor:
        def __init__(self, **kwargs):
            captured.clear()
            captured.update(kwargs)

    class DummyVertexai:
        @staticmethod
        def init(**kwargs):
            init_calls.append(kwargs)

    monkeypatch.setattr("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI", DummyCtor)
    monkeypatch.setattr("helpudoc_agent.gemini_chat.vertexai", DummyVertexai)

    # api_key is present but must NOT be forwarded in Vertex mode (ADC auth).
    cfg = ModelConfig(
        provider="gemini",
        name="m",
        api_key="should-not-be-used",
        use_vertex_ai=True,
        project="my-proj",
        location="us-central1",
    )
    create_chat_google_generative_ai(cfg, "gemini-demo")

    assert init_calls == [{"project": "my-proj", "location": "us-central1"}]
    assert captured["vertexai"] is True
    assert captured["project"] == "my-proj"
    assert captured["location"] == "us-central1"
    assert "api_key" not in captured


def test_gemini_factory_vertex_requires_project_and_location(monkeypatch):
    from helpudoc_agent.configuration import ModelConfig
    from helpudoc_agent.gemini_chat import create_chat_google_generative_ai

    monkeypatch.setattr("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI", lambda **_k: None)

    cfg = ModelConfig(provider="gemini", name="m", use_vertex_ai=True, project=None, location=None)
    with pytest.raises(ValueError):
        create_chat_google_generative_ai(cfg, "gemini-demo")
