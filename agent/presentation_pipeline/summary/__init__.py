"""Compatibility namespace for presentation pipeline summary modules."""

from pathlib import Path

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "summary"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

