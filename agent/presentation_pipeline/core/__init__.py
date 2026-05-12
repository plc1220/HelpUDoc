"""Compatibility namespace for presentation pipeline core modules."""

from pathlib import Path

from paper2slides.core import (
    STAGES,
    create_state,
    detect_start_stage,
    get_base_dir,
    get_config_dir,
    get_config_name,
    get_output_dir,
    get_plan_checkpoint,
    get_rag_checkpoint,
    get_summary_checkpoint,
    get_summary_md,
    list_outputs,
    load_state,
    run_pipeline,
    save_state,
)

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "core"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

__all__ = [
    "get_base_dir",
    "get_config_name",
    "get_config_dir",
    "get_rag_checkpoint",
    "get_summary_checkpoint",
    "get_summary_md",
    "get_plan_checkpoint",
    "get_output_dir",
    "STAGES",
    "load_state",
    "save_state",
    "create_state",
    "detect_start_stage",
    "run_pipeline",
    "list_outputs",
]
