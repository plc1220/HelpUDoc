"""Versioned deterministic foundations for Knowledge ingestion.

The package deliberately keeps extraction, structure detection, and window
planning free of model calls. Model-assisted enrichment consumes these stable
contracts in later stages.
"""

from .pipeline import extract_and_plan_document, extract_and_plan_document_with_gemini

__all__ = ["extract_and_plan_document", "extract_and_plan_document_with_gemini"]
