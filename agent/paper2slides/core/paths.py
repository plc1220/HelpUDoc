"""
Path generation functions for checkpoints and outputs
"""
from pathlib import Path
from datetime import datetime
from typing import Dict


def get_base_dir(output_dir: str, project_name: str, content_type: str) -> Path:
    """Get base directory for project."""
    return Path(output_dir) / project_name / content_type


def get_mode_dir(base_dir: Path, config: Dict) -> Path:
    """Get mode-specific directory (fast or normal)."""
    fast_mode = config.get("fast_mode", False)
    mode = "fast" if fast_mode else "normal"
    return base_dir / mode


def get_config_name(config: Dict) -> str:
    """Generate config directory name: {output}_{style}_{param}."""
    output_type = config.get("output_type", "slides")
    style = config.get("style", "academic")
    
    if output_type == "poster":
        param = config.get("poster_density", "medium")
    else:
        param = config.get("slides_length", "medium")
    
    # Handle custom style. Use hash suffix
    if style == "custom":
        custom = config.get("custom_style", "")
        # Use first 16 chars of custom style
        suffix = custom[:16].replace(" ", "_").replace("/", "_") if custom else "custom"
        style = f"custom_{suffix}"
    
    return f"{output_type}_{style}_{param}"


def get_config_dir(base_dir: Path, config: Dict) -> Path:
    """Get config-specific directory for plan and output."""
    mode_dir = get_mode_dir(base_dir, config)
    return mode_dir / get_config_name(config)


def get_rag_checkpoint(base_dir: Path, config: Dict) -> Path:
    """Get path to RAG checkpoint file."""
    mode_dir = get_mode_dir(base_dir, config)
    return mode_dir / "checkpoint_rag.json"


def get_summary_checkpoint(base_dir: Path, config: Dict) -> Path:
    """Get path to summary checkpoint file."""
    mode_dir = get_mode_dir(base_dir, config)
    return mode_dir / "checkpoint_summary.json"


def get_summary_md(base_dir: Path, config: Dict) -> Path:
    """Get path to summary markdown file."""
    mode_dir = get_mode_dir(base_dir, config)
    return mode_dir / "summary.md"


def get_plan_checkpoint(config_dir: Path) -> Path:
    """Get path to plan checkpoint file."""
    return config_dir / "checkpoint_plan.json"


def get_output_dir(config_dir: Path) -> Path:
    """Get output directory with timestamp to preserve history."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return config_dir / timestamp
