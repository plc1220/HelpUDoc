"""Compatibility-forward entrypoint for presentation generation helpers."""
from __future__ import annotations

from .paper2slides_runner import export_pptx_from_pdf, run_paper2slides

__all__ = ["run_paper2slides", "export_pptx_from_pdf"]

