"""
Figure extraction from markdown documents
"""
import re
from typing import List, Tuple, Optional
from ..models import FigureInfo


def extract_figures(
    content: str,
    lines: List[str],
    search_range: int = 5,
    search_chars: int = 500,
) -> List[FigureInfo]:
    """
    Extract figures from markdown content.
    
    Args:
        content: Full markdown content
        lines: Content split by lines
        search_range: Number of lines to search for captions
        search_chars: Number of characters to search (fallback)
    
    Returns:
        List of extracted FigureInfo objects
    """
    figures = []
    unnamed_figure_count = 0
    
    # Pattern: ![alt_text](images/path.jpg)
    image_pattern = r'!\[([^\]]*)\]\((images/[^\)]+)\)'
    for match in re.finditer(image_pattern, content):
        image_path = match.group(2)
        image_line = content[:match.start()].count('\n')
        
        # Primary search: line-based
        figure_id, caption = _find_figure_caption(lines, image_line, search_range)
        
        # Fallback: character-position-based search
        if figure_id is None:
            figure_id, caption = _find_figure_caption_by_position(
                content, match.start(), match.end(), search_chars
            )
        
        # Generate fallback ID if not found (use different prefix to avoid conflict)
        if not figure_id:
            unnamed_figure_count += 1
            figure_id = f"Doc Figure {unnamed_figure_count}"
        
        figures.append(FigureInfo(
            figure_id=figure_id,
            caption=caption,
            image_path=image_path,
            line_number=image_line,
        ))
    
    return figures


def _find_figure_caption(
    lines: List[str], 
    image_line: int, 
    search_range: int
) -> Tuple[Optional[str], Optional[str]]:
    """
    Search for Figure caption near an image.
    
    Search strategy: First search forward (more common), then backward.
    Stops if encountering a section header or another image.
    
    Args:
        lines: All lines of the document
        image_line: Line number where the image is located
        search_range: Number of lines to search
    """
    figure_pattern = r'^((?:Figure|Image)\s+\d+[a-z]?)\s*:\s*(.+)$'
    
    # Search forward (caption after image)
    for i in range(image_line + 1, min(image_line + search_range + 1, len(lines))):
        match = re.match(figure_pattern, lines[i].strip(), re.IGNORECASE)
        if match:
            return match.group(1), match.group(2)
        # Stop if hitting a section header or another image
        if lines[i].startswith('#') or lines[i].startswith('!['):
            break
    
    # Search backward (caption before image)
    for i in range(image_line - 1, max(image_line - search_range - 1, -1), -1):
        match = re.match(figure_pattern, lines[i].strip(), re.IGNORECASE)
        if match:
            return match.group(1), match.group(2)
        # Stop if hitting a section header or a table
        if lines[i].startswith('#') or '<table>' in lines[i].lower():
            break
    
    return None, None


def _find_figure_caption_by_position(
    content: str,
    element_start: int,
    element_end: int,
    search_chars: int = 500
) -> Tuple[Optional[str], Optional[str]]:
    """
    Fallback: Search for Figure caption by character position.
    
    This is used when line-based search fails, typically when the markdown
    has long paragraphs without line breaks.
    
    Args:
        content: Full document content
        element_start: Character position where the element starts
        element_end: Character position where the element ends
        search_chars: Number of characters to search before/after
    """
    figure_pattern = r'((?:Figure|Image)\s+\d+[a-z]?)\s*[:\.]?\s*([^\n]+)'
    
    # Search after element (more common for figures)
    search_end = min(element_end + search_chars, len(content))
    after_text = content[element_end:search_end]
    match = re.search(figure_pattern, after_text, re.IGNORECASE)
    if match:
        return match.group(1), match.group(2).strip()
    
    # Search before element
    search_start = max(element_start - search_chars, 0)
    before_text = content[search_start:element_start]
    match = re.search(figure_pattern, before_text, re.IGNORECASE)
    if match:
        return match.group(1), match.group(2).strip()
    
    return None, None

