"""
Summary module - process RAG results for document summarization.
"""
from pathlib import Path

_legacy_dir = Path(__file__).resolve().parents[2] / "paper2slides" / "summary"
if _legacy_dir.exists():
    __path__.append(str(_legacy_dir))

from .clean import clean_rag_results, clean_references
from .config import SourceType, SummaryConfig
from .extractors import (
    TABLE_PLACEHOLDER,
    create_enhanced_summary,
    extract_figures,
    extract_tables,
    extract_tables_and_figures,
    identify_table_blocks,
    remove_tables_from_summary,
)
from .general import GeneralContent, extract_general, merge_answers as merge_general_answers
from .models import EnhancedSummary, FigureInfo, OriginalElements, TableInfo
from .paper import (
    LLM_SECTIONS,
    SECTION_SUPPLEMENTS,
    SECTION_TITLES,
    SUMMARY_SECTIONS,
    PaperContent,
    RAGResults,
    extract_paper,
    merge_answers as merge_paper_answers,
)
from ..rag import RAGQueryResult

__all__ = [
    "SourceType",
    "SummaryConfig",
    "clean_references",
    "clean_rag_results",
    "RAGQueryResult",
    "RAGResults",
    "PaperContent",
    "SUMMARY_SECTIONS",
    "LLM_SECTIONS",
    "SECTION_TITLES",
    "SECTION_SUPPLEMENTS",
    "extract_paper",
    "merge_paper_answers",
    "GeneralContent",
    "extract_general",
    "merge_general_answers",
    "TableInfo",
    "FigureInfo",
    "OriginalElements",
    "EnhancedSummary",
    "extract_tables",
    "extract_figures",
    "remove_tables_from_summary",
    "identify_table_blocks",
    "TABLE_PLACEHOLDER",
    "extract_tables_and_figures",
    "create_enhanced_summary",
]

