"""Build chat clients; retain the historical factory name for existing callers."""
from __future__ import annotations

import os
from typing import TYPE_CHECKING

import vertexai
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.language_models.chat_models import BaseChatModel

if TYPE_CHECKING:
    from .configuration import ModelConfig


def create_chat_google_generative_ai(
    cfg: "ModelConfig",
    model_name: str,
    *,
    thinking_level: str | None = None,
    max_output_tokens: int | None = None,
    timeout: float | None = None,
    request_timeout: float | None = None,
) -> BaseChatModel:
    """Build ChatGoogleGenerativeAI with HelpUDoc config.

    ``max_output_tokens`` maps to LangChain Google GenAi's validated alias ``max_tokens``
    (the underlying field remains ``max_output_tokens``).

    Prefer ``request_timeout`` (validated alias); ``timeout`` is kept as an ergonomic
    synonym for call sites passing a deadline in seconds.
    """
    if cfg.provider == "openai-compatible":
        from langchain_openai import ChatOpenAI

        # Never inherit a Google key or a public OpenAI endpoint in private mode.
        api_key = (os.getenv(cfg.api_key_env) or "").strip()
        if not api_key:
            raise ValueError(f"Private inference credential {cfg.api_key_env} is not configured")
        kwargs: dict = {
            "model": model_name,
            "base_url": cfg.base_url,
            "api_key": api_key,
            "use_responses_api": False,
            "stream_usage": False,
            "max_retries": 2,
        }
        if max_output_tokens is not None:
            # NIM follows the Chat Completions max_tokens field. ChatOpenAI
            # renames its own max_tokens field to max_completion_tokens, so
            # pass this explicitly in the provider request body instead.
            kwargs["extra_body"] = {"max_tokens": int(max_output_tokens)}
        deadline = request_timeout if request_timeout is not None else timeout
        if deadline is not None:
            kwargs["timeout"] = float(deadline)
        # thinking_level is a Gemini extension; do not send it to NIM/vLLM.
        return ChatOpenAI(**kwargs)

    api_key = (
        cfg.api_key
        or os.getenv("GOOGLE_CLOUD_API_KEY")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
    )
    kwargs: dict = {"model": model_name}
    if thinking_level:
        kwargs["thinking_level"] = thinking_level
    if max_output_tokens is not None:
        kwargs["max_tokens"] = int(max_output_tokens)
    deadline = request_timeout if request_timeout is not None else timeout
    if deadline is not None:
        kwargs["request_timeout"] = float(deadline)

    # A provisioned API key is an explicit credential for the Gemini Developer
    # API. Prefer it over Vertex ADC so Kubernetes deployments do not silently
    # depend on an unbound workload identity.
    use_vertex = cfg.use_vertex_ai and not api_key
    if use_vertex:
        if not cfg.project or not cfg.location:
            raise ValueError("Vertex AI mode requires both project and location")
        vertexai.init(project=cfg.project, location=cfg.location)
        kwargs["vertexai"] = True
        kwargs["project"] = cfg.project
        kwargs["location"] = cfg.location
    else:
        kwargs["vertexai"] = False
        if api_key:
            kwargs["api_key"] = api_key

    return ChatGoogleGenerativeAI(**kwargs)
