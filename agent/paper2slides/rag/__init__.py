from .config import RAGConfig

# RAGClient depends on LightRAG. Make the import optional so non-RAG flows (e.g.,
# running from summary stage) do not crash on missing lightrag.
try:  # pragma: no cover - exercised in runtime, not tests
    from .client import RAGClient  # type: ignore
    RAG_AVAILABLE = True
except Exception:  # pragma: no cover - allow missing lightrag
    RAGClient = None  # type: ignore
    RAG_AVAILABLE = False

from .query import (
    RAGQueryResult,
    RAG_PAPER_QUERIES,
    RAG_QUERY_MODES,
    SKIP_LLM_SECTIONS,
    GENERAL_OVERVIEW_QUERIES,
    get_queries,
    generate_general_queries,
)

__all__ = [
    "RAGConfig",
    "RAGClient",
    "RAG_AVAILABLE",
    "RAGQueryResult",
    "RAG_PAPER_QUERIES",
    "RAG_QUERY_MODES",
    "SKIP_LLM_SECTIONS",
    "GENERAL_OVERVIEW_QUERIES",
    "get_queries",
    "generate_general_queries",
]
