"""
Pipeline stages for paper2slides
"""
from .rag_stage import run_rag_stage
from .summary_stage import run_summary_stage
from .plan_stage import run_plan_stage
from .generate_stage import run_generate_stage

__all__ = [
    "run_rag_stage",
    "run_summary_stage",
    "run_plan_stage",
    "run_generate_stage",
]
