"""
Table removal and cleaning utilities
"""
import re
from typing import List, Tuple


TABLE_PLACEHOLDER = "*[Table removed. See Appendix A: Original Tables for accurate data.]*"


def remove_tables_from_summary(
    summary_content: str, 
    placeholder: str = TABLE_PLACEHOLDER,
) -> str:
    """
    Remove all tables from summary content.
    
    Supports both formats:
    1. Markdown tables: | col1 | col2 | with |---|---| separator
    2. HTML tables: <table>...</table>
    
    Args:
        summary_content: The summary text content
        placeholder: Text to insert where tables were removed.
                    Default provides a hint to check the appendix.
    """
    cleaned = summary_content
    
    # Method 1: Remove markdown tables
    cleaned = _remove_markdown_tables(cleaned, placeholder)
    
    # Method 2: Remove HTML tables
    html_table_pattern = r'<table>.*?</table>'
    replacement = placeholder + '\n\n' if placeholder else ''
    cleaned = re.sub(html_table_pattern, replacement, cleaned, flags=re.DOTALL)
    
    # Clean up excessive blank lines
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    
    return cleaned.strip()


def _remove_markdown_tables(content: str, placeholder: str = "") -> str:
    """
    Remove markdown format tables from content.
    
    A valid markdown table must have:
    - At least 2 consecutive lines starting and ending with |
    - A separator row containing |---|---| pattern
    
    Args:
        content: Text content to process
        placeholder: Replacement text for removed tables
    """
    lines = content.split('\n')
    result_lines = []
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        # Check if this line starts a table (starts and ends with |)
        if line.strip().startswith('|') and line.strip().endswith('|'):
            # Collect all consecutive table lines
            table_start = i
            table_lines = []
            
            while i < len(lines) and lines[i].strip().startswith('|') and lines[i].strip().endswith('|'):
                table_lines.append(lines[i])
                i += 1
            
            # Validate if this is a real table (has separator row)
            if len(table_lines) >= 2:
                # Check for separator row: |---|---| or |:---|:---| etc.
                has_separator = any(
                    re.match(r'^\|[\s\-:|]+\|$', l.strip()) 
                    for l in table_lines
                )
                if has_separator:
                    # Valid table found, replace with placeholder
                    if placeholder:
                        result_lines.append(placeholder)
                    # Skip the table (already advanced i past it)
                    continue
            
            # Not a valid table, keep original lines
            result_lines.extend(table_lines)
        else:
            result_lines.append(line)
            i += 1
    
    return '\n'.join(result_lines)


def identify_table_blocks(content: str) -> List[Tuple[int, int, str]]:
    """
    Identify all table blocks in content.
    
    Useful for debugging or selective table handling.
    
    Args:
        content: Text content to analyze
    
    Returns:
        List of (start_line, end_line, table_content) tuples
    """
    lines = content.split('\n')
    tables = []
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        if line.strip().startswith('|') and line.strip().endswith('|'):
            start = i
            table_lines = []
            
            while i < len(lines) and lines[i].strip().startswith('|') and lines[i].strip().endswith('|'):
                table_lines.append(lines[i])
                i += 1
            
            # Validate table
            if len(table_lines) >= 2:
                has_separator = any(
                    re.match(r'^\|[\s\-:|]+\|$', l.strip()) 
                    for l in table_lines
                )
                if has_separator:
                    tables.append((start, i - 1, '\n'.join(table_lines)))
        else:
            i += 1
    
    return tables

