"""Utilities package for presentation pipeline with legacy fallback."""

from pathlib import Path

from .file_utils import load_json, save_json, save_text
from .logging import log_section, setup_logging

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "utils"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

__all__ = [
    "save_json",
    "load_json",
    "save_text",
    "setup_logging",
    "log_section",
]

