from __future__ import annotations

import importlib.util


def _has_spec(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def test_new_document_intelligence_raganything_import_path_resolves() -> None:
    assert _has_spec("document_intelligence.raganything")
    assert _has_spec("document_intelligence.raganything.parser")


def test_legacy_paper2slides_raganything_import_path_resolves() -> None:
    assert _has_spec("paper2slides.raganything")
    assert _has_spec("paper2slides.raganything.parser")


def test_top_level_raganything_compat_import_path_resolves() -> None:
    assert _has_spec("raganything")
    assert _has_spec("raganything.parser")

