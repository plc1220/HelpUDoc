from __future__ import annotations

from importlib import import_module
from pathlib import Path
from typing import Any

_new_pkg_dir = Path(__file__).resolve().parent.parent / "document_intelligence" / "raganything"
_legacy_pkg_dir = Path(__file__).resolve().parent.parent / "paper2slides" / "raganything"
if _new_pkg_dir.exists():
    __path__.append(str(_new_pkg_dir))
if _legacy_pkg_dir.exists():
    __path__.append(str(_legacy_pkg_dir))

__all__ = ["RAGAnything", "RAGAnythingConfig"]


def __getattr__(name: str) -> Any:
    if name == "RAGAnything":
        return import_module(".raganything", __name__).RAGAnything
    if name == "RAGAnythingConfig":
        return import_module(".config", __name__).RAGAnythingConfig
    raise AttributeError(name)
