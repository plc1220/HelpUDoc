"""
Table extraction from markdown documents
"""
import re
from typing import List, Tuple, Optional
from ..models import TableInfo


def extract_tables(
    content: str,
    lines: List[str],
    search_range: int = 5,
    search_chars: int = 500,
) -> List[TableInfo]:
    """
    Extract tables from markdown content.
    
    Args:
        content: Full markdown content
        lines: Content split by lines
        search_range: Number of lines to search for captions
        search_chars: Number of characters to search (fallback)
    
    Returns:
        List of extracted TableInfo objects
    """
    tables = []
    unnamed_table_count = 0
    
    # Pattern: <table>...</table>
    table_html_pattern = r'<table>.*?</table>'
    for match in re.finditer(table_html_pattern, content, re.DOTALL):
        html_content = match.group(0)
        table_line = content[:match.start()].count('\n')
        
        # Primary search: line-based
        table_id, caption = _find_table_caption(lines, table_line, search_range)
        
        # Fallback: character-position-based search
        if table_id is None:
            table_id, caption = _find_table_caption_by_position(
                content, match.start(), match.end(), search_chars
            )
        
        # Generate fallback ID if not found
        if not table_id:
            unnamed_table_count += 1
            table_id = f"Doc Table {unnamed_table_count}"
        
        tables.append(TableInfo(
            table_id=table_id,
            caption=caption or "",
            html_content=html_content,
            line_number=table_line,
        ))
    
    return tables


def _find_table_caption(
    lines: List[str], 
    table_line: int, 
    search_range: int
) -> Tuple[Optional[str], Optional[str]]:
    """
    Search for Table caption near an HTML table.
    
    Search strategy: First search backward (more common), then forward.
    Stops if encountering a section header.
    
    Args:
        lines: All lines of the document
        table_line: Line number where the table starts
        search_range: Number of lines to search
    """
    table_pattern = r'^(Table\s+\d+[a-z]?)\s*:\s*(.+)$'
    
    # Search backward (caption before table)
    for i in range(table_line - 1, max(table_line - search_range - 1, -1), -1):
        match = re.match(table_pattern, lines[i].strip(), re.IGNORECASE)
        if match:
            return match.group(1), match.group(2)
        # Stop if hitting a section header
        if lines[i].startswith('#'):
            break
    
    # Search forward (caption after table)
    # Need to skip past the table itself first
    table_end_line = table_line
    for i in range(table_line, len(lines)):
        if '</table>' in lines[i].lower():
            table_end_line = i
            break
    
    for i in range(table_end_line + 1, min(table_end_line + search_range + 1, len(lines))):
        match = re.match(table_pattern, lines[i].strip(), re.IGNORECASE)
        if match:
            return match.group(1), match.group(2)
        if lines[i].startswith('#'):
            break
    
    return None, None


def _find_table_caption_by_position(
    content: str,
    element_start: int,
    element_end: int,
    search_chars: int = 500
) -> Tuple[Optional[str], Optional[str]]:
    """
    Fallback: Search for Table caption by character position.
    
    This is used when line-based search fails, typically when the markdown
    has long paragraphs without line breaks.
    
    Args:
        content: Full document content
        element_start: Character position where the element starts
        element_end: Character position where the element ends
        search_chars: Number of characters to search before/after
    """
    table_pattern = r'(Table\s+\d+[a-z]?)\s*[:\.]?\s*([^\n]+)'
    
    # Search before element (more common for tables)
    search_start = max(element_start - search_chars, 0)
    before_text = content[search_start:element_start]
    match = re.search(table_pattern, before_text, re.IGNORECASE)
    if match:
        return match.group(1), match.group(2).strip()
    
    # Search after element
    search_end = min(element_end + search_chars, len(content))
    after_text = content[element_end:search_end]
    match = re.search(table_pattern, after_text, re.IGNORECASE)
    if match:
        return match.group(1), match.group(2).strip()
    
    return None, None

