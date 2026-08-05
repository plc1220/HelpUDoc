from types import SimpleNamespace
from unittest.mock import patch

from helpudoc_agent.configuration import ModelConfig
from helpudoc_agent.gemini_chat import create_chat_google_generative_ai
from helpudoc_agent.tools.workspace.gemini_client import GeminiClientManager


def _vertex_model_config() -> ModelConfig:
    return ModelConfig(
        name="gemini-3.1-flash-lite",
        project="example-project",
        location="global",
        api_key=None,
        use_vertex_ai=True,
    )


def test_workspace_client_uses_vertex_credentials_without_api_key() -> None:
    config = _vertex_model_config()

    with (
        patch("helpudoc_agent.tools.workspace.gemini_client.vertexai.init"),
        patch("helpudoc_agent.tools.workspace.gemini_client.genai.Client") as client,
    ):
        GeminiClientManager(SimpleNamespace(model=config))

    kwargs = client.call_args.kwargs
    assert kwargs["vertexai"] is True
    assert kwargs["project"] == "example-project"
    assert kwargs["location"] == "global"
    assert "api_key" not in kwargs


def test_chat_model_uses_vertex_credentials_without_api_key() -> None:
    config = _vertex_model_config()

    with (
        patch("helpudoc_agent.gemini_chat.vertexai.init"),
        patch("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI") as chat_model,
    ):
        create_chat_google_generative_ai(config, config.name)

    kwargs = chat_model.call_args.kwargs
    assert kwargs["vertexai"] is True
    assert kwargs["project"] == "example-project"
    assert kwargs["location"] == "global"
    assert "api_key" not in kwargs


def test_api_key_mode_still_passes_api_key() -> None:
    config = ModelConfig(
        name="gemini-3.1-flash-lite",
        api_key="configured-api-key",
        use_vertex_ai=False,
    )

    with patch("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI") as chat_model:
        create_chat_google_generative_ai(config, config.name)

    kwargs = chat_model.call_args.kwargs
    assert kwargs["vertexai"] is False
    assert kwargs["api_key"] == "configured-api-key"


def test_provisioned_api_key_takes_precedence_over_vertex_config() -> None:
    config = ModelConfig(
        name="gemini-3.1-flash-lite",
        project="example-project",
        location="global",
        api_key="configured-api-key",
        use_vertex_ai=True,
    )

    with (
        patch("helpudoc_agent.tools.workspace.gemini_client.vertexai.init") as vertex_init,
        patch("helpudoc_agent.tools.workspace.gemini_client.genai.Client") as client,
        patch("helpudoc_agent.gemini_chat.vertexai.init") as chat_vertex_init,
        patch("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI") as chat_model,
    ):
        GeminiClientManager(SimpleNamespace(model=config))
        create_chat_google_generative_ai(config, config.name)

    client_kwargs = client.call_args.kwargs
    assert client_kwargs["vertexai"] is False
    assert client_kwargs["api_key"] == "configured-api-key"
    assert "project" not in client_kwargs
    assert "location" not in client_kwargs
    vertex_init.assert_not_called()

    chat_kwargs = chat_model.call_args.kwargs
    assert chat_kwargs["vertexai"] is False
    assert chat_kwargs["api_key"] == "configured-api-key"
    assert "project" not in chat_kwargs
    assert "location" not in chat_kwargs
    chat_vertex_init.assert_not_called()
