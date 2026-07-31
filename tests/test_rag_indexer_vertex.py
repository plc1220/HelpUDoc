"""Vertex AI support in the RAG indexer: embeddings ADC branch + config wiring."""

from __future__ import annotations

import asyncio
import sys
import types as pytypes
from pathlib import Path


def _install_fake_genai(monkeypatch, record):
    """Inject fake google.genai modules so _embed_gemini runs without the SDK."""
    google_mod = pytypes.ModuleType("google")
    genai_mod = pytypes.ModuleType("google.genai")
    genai_types_mod = pytypes.ModuleType("google.genai.types")

    class _Emb:
        def __init__(self, values):
            self.values = values

    class _Resp:
        def __init__(self, embeddings):
            self.embeddings = embeddings

    class _Models:
        def embed_content(self, *, model, contents, config):
            record["model"] = model
            record["contents"] = list(contents)
            return _Resp([_Emb([0.1, 0.2, 0.3]) for _ in contents])

    class _Client:
        def __init__(self, **kwargs):
            record["client_kwargs"] = kwargs
            self.models = _Models()

    class _EmbedContentConfig:
        def __init__(self, **kwargs):
            record["embed_config"] = kwargs

    genai_mod.Client = _Client
    genai_mod.types = genai_types_mod
    genai_types_mod.EmbedContentConfig = _EmbedContentConfig
    google_mod.genai = genai_mod

    monkeypatch.setitem(sys.modules, "google", google_mod)
    monkeypatch.setitem(sys.modules, "google.genai", genai_mod)
    monkeypatch.setitem(sys.modules, "google.genai.types", genai_types_mod)


def test_embed_gemini_vertex_uses_adc_without_api_key(monkeypatch):
    from helpudoc_agent.rag_indexer import _embed_gemini

    record: dict = {}
    _install_fake_genai(monkeypatch, record)

    result = asyncio.run(
        _embed_gemini(
            ["alpha", "beta"],
            model="gemini-embedding-001",
            api_key=None,
            output_dimensionality=3,
            use_vertex_ai=True,
            project="my-proj",
            location="us-central1",
        )
    )

    assert record["client_kwargs"] == {
        "vertexai": True,
        "project": "my-proj",
        "location": "us-central1",
    }
    assert "api_key" not in record["client_kwargs"]
    assert result.shape == (2, 3)


def test_embed_gemini_vertex_requires_project_and_location(monkeypatch):
    from helpudoc_agent.rag_indexer import _embed_gemini

    record: dict = {}
    _install_fake_genai(monkeypatch, record)

    import pytest

    with pytest.raises(RuntimeError):
        asyncio.run(
            _embed_gemini(
                ["alpha"],
                model="gemini-embedding-001",
                api_key=None,
                output_dimensionality=3,
                use_vertex_ai=True,
                project=None,
                location=None,
            )
        )


def _clear_rag_env(monkeypatch):
    for name in (
        "GEMINI_API_KEY",
        "LLM_BINDING_API_KEY",
        "RAG_OFFLINE",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
    ):
        monkeypatch.delenv(name, raising=False)


def test_rag_config_vertex_not_forced_offline(monkeypatch):
    from helpudoc_agent.rag_indexer import RagConfig

    _clear_rag_env(monkeypatch)
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-proj")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")

    cfg = RagConfig.from_env(Path("/tmp/ws"))

    assert cfg.use_vertex_ai is True
    assert cfg.project == "my-proj"
    assert cfg.location == "us-central1"
    # Vertex ADC is a valid credential, so absence of GEMINI_API_KEY must not force offline.
    assert cfg.offline is False


def test_rag_config_offline_without_any_credentials(monkeypatch):
    from helpudoc_agent.rag_indexer import RagConfig

    _clear_rag_env(monkeypatch)

    cfg = RagConfig.from_env(Path("/tmp/ws"))

    assert cfg.use_vertex_ai is False
    assert cfg.offline is True
