"""
Generator configuration and input types.
"""
from dataclasses import dataclass
from typing import Optional, Dict, Any, Union
from enum import Enum

from paper2slides.summary import OriginalElements, PaperContent, GeneralContent


class OutputType(str, Enum):
    """Output type for generation."""
    POSTER = "poster"
    SLIDES = "slides"


class PosterDensity(str, Enum):
    """Content density level for poster."""
    SPARSE = "sparse"   
    MEDIUM = "medium"   
    DENSE = "dense"     


class SlidesLength(str, Enum):
    """Page count level for slides."""
    SHORT = "short"      # 5-8 pages
    MEDIUM = "medium"    # 8-12 pages
    LONG = "long"        # 12-15 pages


class StyleType(str, Enum):
    """Predefined style types."""
    ACADEMIC = "academic"
    DORAEMON = "doraemon"
    CUSTOM = "custom"


# Page count ranges for each slides length
SLIDES_PAGE_RANGES: Dict[str, tuple[int, int]] = {
    "short": (5, 8),
    "medium": (8, 12),
    "long": (12, 15),
}


@dataclass
class GenerationConfig:
    """
    User configuration for generation.
    
    Attributes:
        output_type: Type of output (poster or slides)
        poster_density: Content density for poster (sparse/medium/dense)
        slides_length: Page count level for slides (short/medium/long)
        style: Style type (academic/doraemon/custom)
        custom_style: User's custom style description (used when style=custom)
    """
    output_type: OutputType = OutputType.POSTER
    
    # Poster specific
    poster_density: PosterDensity = PosterDensity.MEDIUM
    
    # Slides specific
    slides_length: SlidesLength = SlidesLength.MEDIUM
    
    # Style
    style: StyleType = StyleType.ACADEMIC
    custom_style: Optional[str] = None
    
    def get_page_range(self) -> tuple[int, int]:
        """Get page count range for slides."""
        return SLIDES_PAGE_RANGES.get(self.slides_length.value, (8, 12))
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "output_type": self.output_type.value,
            "poster_density": self.poster_density.value,
            "slides_length": self.slides_length.value,
            "style": self.style.value,
            "custom_style": self.custom_style,
        }


@dataclass
class GenerationInput:
    """
    Complete input for generation.
    
    Attributes:
        config: User generation config
        content: PaperContent or GeneralContent from summary module
        origin: Original tables and figures from source_extractor
    """
    config: GenerationConfig
    content: Union[PaperContent, GeneralContent]
    origin: OriginalElements
    
    def is_paper(self) -> bool:
        """Check if content is from a paper document."""
        return isinstance(self.content, PaperContent)
    
    def get_summary_text(self) -> str:
        """Get the full summary text."""
        if isinstance(self.content, PaperContent):
            return self.content.to_summary()
        else:
            return self.content.content
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "config": self.config.to_dict(),
            "is_paper": self.is_paper(),
            "summary": self.get_summary_text(),
            "tables": self.origin.get_table_info(),
            "figures": self.origin.get_figure_info(),
        }
