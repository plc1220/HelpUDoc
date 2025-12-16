"""
Extractors for tables, figures, and table cleaning
"""
from pathlib import Path
from .table_extractor import extract_tables
from .figure_extractor import extract_figures
from .table_cleaner import remove_tables_from_summary, identify_table_blocks, TABLE_PLACEHOLDER
from ..models import OriginalElements, EnhancedSummary


def extract_tables_and_figures(
    markdown_path: str, 
    search_range: int = 5,
    search_chars: int = 500,
    include_base_path: bool = True,
) -> OriginalElements:
    """
    Extract tables and figures from original markdown file.
    
    This function searches for HTML tables and images, then looks for their
    captions within a configurable range of lines. If line-based search fails,
    it falls back to character-position-based search.
    
    Args:
        markdown_path: Path to the markdown file
        search_range: Number of lines to search for captions (before/after element)
        search_chars: Number of characters to search (fallback when line search fails)
        include_base_path: If True, set base_path to the parent directory of markdown_path
    """
    with open(markdown_path, "r", encoding="utf-8") as f:
        content = f.read()
        lines = content.split('\n')
    
    elements = OriginalElements()
    
    if include_base_path:
        elements.base_path = str(Path(markdown_path).parent)
    
    # Extract figures
    elements.figures = extract_figures(content, lines, search_range, search_chars)
    
    # Extract tables
    elements.tables = extract_tables(content, lines, search_range, search_chars)
    
    return elements


def create_enhanced_summary(
    summary_content: str,
    original_markdown_path: str,
    remove_tables: bool = True,
    table_placeholder: str = TABLE_PLACEHOLDER,
) -> EnhancedSummary:
    """
    Create an enhanced summary by separating summary text and original elements.
    
    Args:
        summary_content: The RAG-generated summary content
        original_markdown_path: Path to the original parsed markdown file
        remove_tables: Whether to remove tables from summary (True for Paper, False for General)
        table_placeholder: Text to insert where tables were removed
    """
    # Extract tables and figures from original markdown
    original_elements = extract_tables_and_figures(original_markdown_path)
    
    # Clean tables from summary if requested
    if remove_tables:
        cleaned_text = remove_tables_from_summary(summary_content, placeholder=table_placeholder)
    else:
        cleaned_text = summary_content
    
    return EnhancedSummary(
        summary_text=cleaned_text,
        origin=original_elements,
        original_markdown_path=original_markdown_path,
    )


__all__ = [
    "extract_tables",
    "extract_figures",
    "remove_tables_from_summary",
    "identify_table_blocks",
    "TABLE_PLACEHOLDER",
    "extract_tables_and_figures",
    "create_enhanced_summary",
]
