"""
Generator module

Generates poster images or slides from RAG summary content.
"""
from .config import (
    OutputType,
    PosterDensity,
    SlidesLength,
    StyleType,
    SLIDES_PAGE_RANGES,
    GenerationConfig,
    GenerationInput,
)
from .content_planner import (
    TableRef,
    FigureRef,
    Section,
    ContentPlan,
    ContentPlanner,
)


__all__ = [
    # Config
    "OutputType",
    "PosterDensity",
    "SlidesLength",
    "StyleType",
    "SLIDES_PAGE_RANGES",
    "GenerationConfig",
    "GenerationInput",
    # Content Planner
    "TableRef",
    "FigureRef",
    "Section",
    "ContentPlan",
    "ContentPlanner",
]
