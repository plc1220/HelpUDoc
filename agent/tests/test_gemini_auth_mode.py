from types import SimpleNamespace
from unittest.mock import patch

from helpudoc_agent.config.env import reset_agent_env_caches_for_tests
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


def test_vertex_config_takes_precedence_over_provisioned_api_key() -> None:
    """`use_vertex_ai` wins even when an API key is available.

    This inverts the guard added in d1beb86. That commit made the key win because
    Vertex had broken in GKE, but the cause was a missing credential rather than
    the precedence: no service-account key was mounted, so ADC had nothing to bind
    to. The key is mounted now, and an AI Studio key is not a valid Vertex
    credential, so it must not be forwarded alongside `vertexai=True`.
    """
    config = ModelConfig(
        name="gemini-3.1-flash-lite",
        project="example-project",
        location="us-central1",
        api_key="configured-api-key",
        use_vertex_ai=True,
    )

    # Both modules bind the same `vertexai` module object, so one patch covers
    # both call sites; patching each name separately would leave the second mock
    # shadowing the first and silently record no calls.
    with (
        patch("vertexai.init") as vertex_init,
        patch("helpudoc_agent.tools.workspace.gemini_client.genai.Client") as client,
        patch("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI") as chat_model,
    ):
        GeminiClientManager(SimpleNamespace(model=config))
        create_chat_google_generative_ai(config, config.name)

    client_kwargs = client.call_args.kwargs
    assert client_kwargs["vertexai"] is True
    assert "api_key" not in client_kwargs
    assert client_kwargs["project"] == "example-project"
    assert client_kwargs["location"] == "us-central1"

    chat_kwargs = chat_model.call_args.kwargs
    assert chat_kwargs["vertexai"] is True
    assert "api_key" not in chat_kwargs
    assert chat_kwargs["project"] == "example-project"
    assert chat_kwargs["location"] == "us-central1"

    # Once from the manager, once from the chat factory.
    assert vertex_init.call_count == 2
    for call in vertex_init.call_args_list:
        assert call.kwargs == {"project": "example-project", "location": "us-central1"}


def test_ambient_api_key_env_does_not_disable_vertex(monkeypatch) -> None:
    """The GKE case: the manifests always inject GEMINI_API_KEY.

    Before the inversion this env var alone silently demoted the runtime to the
    Gemini Developer API, so `use_vertex_ai: true` in runtime.yaml was inert.
    """
    monkeypatch.setenv("GEMINI_API_KEY", "ambient-key")
    reset_agent_env_caches_for_tests()
    try:
        config = ModelConfig(
            name="gemini-3.1-flash-lite",
            project="example-project",
            location="us-central1",
            use_vertex_ai=True,
        )
        with (
            patch("helpudoc_agent.gemini_chat.vertexai.init"),
            patch("helpudoc_agent.gemini_chat.ChatGoogleGenerativeAI") as chat_model,
        ):
            create_chat_google_generative_ai(config, config.name)
    finally:
        reset_agent_env_caches_for_tests()

    chat_kwargs = chat_model.call_args.kwargs
    assert chat_kwargs["vertexai"] is True
    assert "api_key" not in chat_kwargs


def test_web_tool_chat_model_uses_lite_model_and_bounded_output() -> None:
    config = ModelConfig(
        name="gemini-main",
        lite_name="gemini-web-lite",
        lite_thinking_level="low",
        lite_max_output_tokens=4096,
        api_key="configured-api-key",
        use_vertex_ai=False,
    )

    with (
        patch("helpudoc_agent.tools.workspace.gemini_client.genai.Client"),
        patch("helpudoc_agent.gemini_chat.create_chat_google_generative_ai") as create_chat,
    ):
        manager = GeminiClientManager(SimpleNamespace(model=config))
        manager.get_web_tool_chat_model()

    args, kwargs = create_chat.call_args
    assert args[1] == "gemini-web-lite"
    assert kwargs["thinking_level"] == "low"
    assert kwargs["max_output_tokens"] == 1024
