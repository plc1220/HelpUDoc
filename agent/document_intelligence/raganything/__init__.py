"""Compatibility-first namespace for the RAGAnything parser package."""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = ["RAGAnything", "RAGAnythingConfig"]


def __getattr__(name: str) -> Any:
    if name == "RAGAnything":
        return import_module(".raganything", __name__).RAGAnything
    if name == "RAGAnythingConfig":
        return import_module(".config", __name__).RAGAnythingConfig
    raise AttributeError(name)
