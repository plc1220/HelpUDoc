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
