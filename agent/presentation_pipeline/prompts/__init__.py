"""Compatibility namespace for presentation pipeline prompt modules."""

from pathlib import Path

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "prompts"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

