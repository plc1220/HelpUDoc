"""Gemini client and LangChain chat model caching for workspace tools."""
from __future__ import annotations

import os
from typing import Any

from langchain_google_genai import ChatGoogleGenerativeAI

try:
    import vertexai
    from google import genai
    from google.genai.types import HttpOptions
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from ...configuration import Settings
from .timeouts import DEFAULT_HTTP_TIMEOUT, DEFAULT_SEARCH_HTTP_TIMEOUT, seconds_to_ms


class GeminiClientManager:
    """Initializes and caches a Gemini client per service."""

    def __init__(self, settings: Settings):
        model_cfg = settings.model
        self._model_cfg = model_cfg
        self._search_chat_model: ChatGoogleGenerativeAI | None = None
        self._attachment_chat_model: ChatGoogleGenerativeAI | None = None
        self._api_key = (
            model_cfg.api_key
            or os.getenv("GOOGLE_CLOUD_API_KEY")
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_API_KEY")
        )

        if model_cfg.provider != "gemini":
            raise ValueError(f"Unsupported model provider {model_cfg.provider}")

        use_vertex = model_cfg.use_vertex_ai

        client_kwargs: dict = {}
        if self._api_key:
            client_kwargs["api_key"] = self._api_key

        if use_vertex:
            if not model_cfg.project or not model_cfg.location:
                raise ValueError("Vertex AI mode requires both project and location")
            vertexai.init(project=model_cfg.project, location=model_cfg.location)
            client_kwargs.update(
                {
                    "vertexai": True,
                    "project": model_cfg.project,
                    "location": model_cfg.location,
                }
            )
        else:
            client_kwargs["vertexai"] = False

        self.client = self._build_client(client_kwargs)
        self.model_name = model_cfg.chat_model_name
        self.image_model_name = model_cfg.image_model_name

    def _build_client(self, client_kwargs: dict[str, Any]) -> Any | None:
        if not self._api_key and not self._model_cfg.use_vertex_ai:
            return None
        return genai.Client(
            **client_kwargs,
            http_options=HttpOptions(timeout=seconds_to_ms(DEFAULT_HTTP_TIMEOUT)),
        )

    def _require_configured_client(self) -> None:
        if not self._api_key and not self._model_cfg.use_vertex_ai:
            raise RuntimeError("Gemini API key is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY before using Gemini-backed tools.")

    def get_search_chat_model(self) -> ChatGoogleGenerativeAI:
        """Tight-timeout chat model for built-in google_search / url_context tools."""
        self._require_configured_client()
        if self._search_chat_model is None:
            from ...gemini_chat import create_chat_google_generative_ai

            self._search_chat_model = create_chat_google_generative_ai(
                self._model_cfg,
                self.model_name,
                timeout=float(DEFAULT_SEARCH_HTTP_TIMEOUT),
            )
        return self._search_chat_model

    def get_attachment_chat_model(self) -> ChatGoogleGenerativeAI:
        """Chat model with standard HTTP deadline for multimodal attachment understanding."""
        self._require_configured_client()
        if self._attachment_chat_model is None:
            from ...gemini_chat import create_chat_google_generative_ai

            self._attachment_chat_model = create_chat_google_generative_ai(
                self._model_cfg,
                self.model_name,
                timeout=float(DEFAULT_HTTP_TIMEOUT),
            )
        return self._attachment_chat_model
