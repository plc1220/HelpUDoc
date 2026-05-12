"""Presentation pipeline namespace (backed by paper2slides during migration)."""

from __future__ import annotations

from importlib import import_module
from pathlib import Path
from typing import Any

_legacy_pkg_dir = Path(__file__).resolve().parents[1] / "paper2slides"
if _legacy_pkg_dir.exists():
    __path__.append(str(_legacy_pkg_dir))

__all__ = ["main"]


def __getattr__(name: str) -> Any:
    if name == "main":
        return import_module("presentation_pipeline.main").main
    raise AttributeError(name)

