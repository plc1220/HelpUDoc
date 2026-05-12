"""Compatibility shim for legacy paper2slides.raganything imports."""

from __future__ import annotations

from importlib import import_module
from pathlib import Path
from typing import Any

_new_pkg_dir = Path(__file__).resolve().parents[2] / "document_intelligence" / "raganything"
if _new_pkg_dir.exists():
    __path__.append(str(_new_pkg_dir))

__all__ = ["RAGAnything", "RAGAnythingConfig"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        return getattr(import_module("document_intelligence.raganything"), name)
    raise AttributeError(name)
