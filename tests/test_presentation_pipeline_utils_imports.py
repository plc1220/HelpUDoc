from __future__ import annotations

import importlib.util


def _has_spec(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def test_presentation_pipeline_utils_paths_resolve() -> None:
    assert _has_spec("presentation_pipeline.utils.export_service")
    assert _has_spec("presentation_pipeline.utils.pptx_builder")


def test_legacy_paper2slides_utils_paths_still_resolve() -> None:
    assert _has_spec("paper2slides.utils.export_service")
    assert _has_spec("paper2slides.utils.pptx_builder")

