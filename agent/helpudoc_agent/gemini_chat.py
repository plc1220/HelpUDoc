"""Create ChatGoogleGenerativeAI instances with HelpUDoc model settings."""
from __future__ import annotations

from typing import TYPE_CHECKING

import vertexai
from langchain_google_genai import ChatGoogleGenerativeAI

from .config.env import resolve_google_auth_mode

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
) -> ChatGoogleGenerativeAI:
    """Build ChatGoogleGenerativeAI with HelpUDoc config.

    ``max_output_tokens`` maps to LangChain Google GenAi's validated alias ``max_tokens``
    (the underlying field remains ``max_output_tokens``).

    Prefer ``request_timeout`` (validated alias); ``timeout`` is kept as an ergonomic
    synonym for call sites passing a deadline in seconds.
    """
    auth = resolve_google_auth_mode(cfg)
    kwargs: dict = {"model": model_name}
    if thinking_level:
        kwargs["thinking_level"] = thinking_level
    if max_output_tokens is not None:
        kwargs["max_tokens"] = int(max_output_tokens)
    deadline = request_timeout if request_timeout is not None else timeout
    if deadline is not None:
        kwargs["request_timeout"] = float(deadline)

    if auth.use_vertex:
        if not cfg.project or not cfg.location:
            raise ValueError("Vertex AI mode requires both project and location")
        vertexai.init(project=cfg.project, location=cfg.location)
        kwargs["vertexai"] = True
        kwargs["project"] = cfg.project
        kwargs["location"] = cfg.location
    else:
        kwargs["vertexai"] = False
        if auth.api_key:
            kwargs["api_key"] = auth.api_key

    return ChatGoogleGenerativeAI(**kwargs)
