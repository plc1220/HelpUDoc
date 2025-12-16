"""
Path handling utilities
"""
from pathlib import Path

PREDEFINED_STYLES = {"academic", "doraemon"}


def normalize_input_path(input_path: str) -> str:
    """Normalize and validate input path."""
    path = Path(input_path).resolve()
    
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {input_path}")
    
    return str(path)


def get_project_name(input_path: str) -> str:
    """Extract project name from input path."""
    path = Path(input_path).resolve()
    
    if path.is_file():
        return path.stem
    elif path.is_dir():
        return path.name
    else:
        return Path(input_path).stem


def parse_style(style_str: str) -> tuple:
    """Parse style string into style type and custom style."""
    if style_str.lower() in PREDEFINED_STYLES:
        return style_str.lower(), None
    else:
        return "custom", style_str

