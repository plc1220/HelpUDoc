"""
Summary module - process RAG results for document summarization.
"""
from .config import SourceType, SummaryConfig
from .clean import clean_references, clean_rag_results
from .paper import (
    RAGResults,
    PaperContent,
    SUMMARY_SECTIONS,
    LLM_SECTIONS,
    SECTION_TITLES,
    SECTION_SUPPLEMENTS,
    extract_paper,
    merge_answers as merge_paper_answers,
)
from .general import (
    GeneralContent,
    extract_general,
    merge_answers as merge_general_answers,
)
from .models import (
    TableInfo,
    FigureInfo,
    OriginalElements,
    EnhancedSummary,
)
from .extractors import (
    extract_tables,
    extract_figures,
    remove_tables_from_summary,
    identify_table_blocks,
    TABLE_PLACEHOLDER,
    extract_tables_and_figures,
    create_enhanced_summary,
)

from ..rag import RAGQueryResult

__all__ = [
    # Config
    "SourceType",
    "SummaryConfig",
    # Clean
    "clean_references",
    "clean_rag_results",
    "RAGQueryResult",
    # Paper (has fixed sections)
    "RAGResults",
    "PaperContent",
    "SUMMARY_SECTIONS",
    "LLM_SECTIONS",
    "SECTION_TITLES",
    "SECTION_SUPPLEMENTS",
    "extract_paper",
    "merge_paper_answers",
    # General (no fixed sections)
    "GeneralContent",
    "extract_general",
    "merge_general_answers",
    # Data models
    "TableInfo",
    "FigureInfo",
    "OriginalElements",
    "EnhancedSummary",
    # Extraction functions
    "extract_tables",
    "extract_figures",
    "remove_tables_from_summary",
    "identify_table_blocks",
    "TABLE_PLACEHOLDER",
    "extract_tables_and_figures",
    "create_enhanced_summary",
]
