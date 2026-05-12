"""
Generator module

Generates poster images or slides from RAG summary content.
"""
from pathlib import Path

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "generator"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

from .config import (
    SLIDES_PAGE_RANGES,
    GenerationConfig,
    GenerationInput,
    OutputType,
    PosterDensity,
    SlidesLength,
    StyleType,
)
from .content_planner import (
    ContentPlan,
    ContentPlanner,
    FigureRef,
    Section,
    TableRef,
)

__all__ = [
    "OutputType",
    "PosterDensity",
    "SlidesLength",
    "StyleType",
    "SLIDES_PAGE_RANGES",
    "GenerationConfig",
    "GenerationInput",
    "TableRef",
    "FigureRef",
    "Section",
    "ContentPlan",
    "ContentPlanner",
]

