"""
Core business logic for paper2slides
"""
from .paths import (
    get_base_dir,
    get_config_name,
    get_config_dir,
    get_rag_checkpoint,
    get_summary_checkpoint,
    get_summary_md,
    get_plan_checkpoint,
    get_output_dir,
)
from .state import (
    STAGES,
    load_state,
    save_state,
    create_state,
    detect_start_stage,
)
from .pipeline import run_pipeline, list_outputs

__all__ = [
    # Path functions
    "get_base_dir",
    "get_config_name",
    "get_config_dir",
    "get_rag_checkpoint",
    "get_summary_checkpoint",
    "get_summary_md",
    "get_plan_checkpoint",
    "get_output_dir",
    # State management
    "STAGES",
    "load_state",
    "save_state",
    "create_state",
    "detect_start_stage",
    # Pipeline
    "run_pipeline",
    "list_outputs",
]

