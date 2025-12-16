"""
Data models for summary extraction
"""
import re
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from pathlib import Path


@dataclass
class TableInfo:
    """Information about an extracted table."""
    table_id: str           # e.g., "Table 1"
    caption: str            # Table caption/description
    html_content: str       # Original HTML table content
    line_number: int = 0    # Line position in original document (for ordering)
    
    def to_markdown(self) -> str:
        """Convert to markdown format with caption."""
        return f"**{self.table_id}**: {self.caption}\n\n{self.html_content}"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.table_id,
            "caption": self.caption,
            "html": self.html_content,
        }


@dataclass
class FigureInfo:
    """Information about an extracted figure."""
    figure_id: str              # e.g., "Figure 1" (fallback generated if not found)
    caption: Optional[str]      # Figure caption or None
    image_path: str             # Relative path to image file
    line_number: int = 0        # Line position in original document
    
    def to_markdown(self, base_path: str = "") -> str:
        """Convert to markdown format with caption before image."""
        full_path = f"{base_path}/{self.image_path}" if base_path else self.image_path
        if self.caption:
            return f"**{self.figure_id}**: {self.caption}\n\n![{self.figure_id}]({full_path})"
        else:
            return f"**{self.figure_id}**\n\n![{self.figure_id}]({full_path})"
    
    def to_dict(self, base_path: str = "") -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.figure_id,
            "caption": self.caption,
            "path": str(Path(base_path) / self.image_path) if base_path else self.image_path,
        }


@dataclass  
class OriginalElements:
    """
    Container for tables and figures extracted from original document.
    
    Attributes:
        tables: List of extracted tables
        figures: List of extracted figures
        base_path: Base directory path for resolving relative image paths
    """
    tables: List[TableInfo] = field(default_factory=list)
    figures: List[FigureInfo] = field(default_factory=list)
    base_path: str = ""
    
    def get_tables_markdown(self) -> str:
        """Get all tables as markdown, sorted by original position."""
        if not self.tables:
            return ""
        sorted_tables = sorted(self.tables, key=lambda x: x.line_number)
        parts = [t.to_markdown() for t in sorted_tables]
        return "\n\n---\n\n".join(parts)
    
    def get_figures_markdown(self) -> str:
        """Get all figures as markdown, sorted by original position."""
        if not self.figures:
            return ""
        sorted_figures = sorted(self.figures, key=lambda x: x.line_number)
        parts = [f.to_markdown(self.base_path) for f in sorted_figures]
        return "\n\n---\n\n".join(parts)
    
    def get_table_info(self) -> List[Dict[str, Any]]:
        """Get table info for JSON serialization."""
        return [t.to_dict() for t in self.tables]
    
    def get_figure_info(self) -> List[Dict[str, Any]]:
        """Get figure info with full paths for JSON serialization."""
        return [f.to_dict(self.base_path) for f in self.figures]
    
    def get_figure_paths(self) -> List[str]:
        """Get list of full paths to figure images."""
        return [
            str(Path(self.base_path) / f.image_path) 
            for f in self.figures
        ]


@dataclass
class EnhancedSummary:
    """
    Summary with separated text and original elements.
    
    Attributes:
        summary_text: Text-based summary content (for text LLM)
        origin: Original tables and figures (for special handling)
        original_markdown_path: Path to the original markdown file
    """
    summary_text: str
    origin: OriginalElements
    original_markdown_path: str
    
    def get_merged_content(
        self,
        include_tables: bool = True,
        include_figures: bool = True,
        table_section_title: str = "# Appendix A: Original Tables",
        figure_section_title: str = "# Appendix B: Original Figures",
    ) -> str:
        """Get merged content for display or saving."""
        parts = [self.summary_text]
        
        if include_tables and self.origin.tables:
            parts.append(f"\n\n---\n\n{table_section_title}\n\n")
            parts.append(self.origin.get_tables_markdown())
        
        if include_figures and self.origin.figures:
            parts.append(f"\n\n---\n\n{figure_section_title}\n\n")
            parts.append(self.origin.get_figures_markdown())
        
        return "".join(parts)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "summary_text": self.summary_text,
            "tables": self.origin.get_table_info(),
            "figures": self.origin.get_figure_info(),
        }

