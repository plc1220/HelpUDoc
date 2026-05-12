from __future__ import annotations


def test_presentation_pipeline_rag_public_exports() -> None:
    from presentation_pipeline.rag import RAGConfig, RAG_PAPER_QUERIES, RAG_QUERY_MODES

    assert RAGConfig is not None
    assert isinstance(RAG_PAPER_QUERIES, dict)
    assert isinstance(RAG_QUERY_MODES, dict)


def test_presentation_pipeline_summary_public_exports() -> None:
    from presentation_pipeline.summary import GeneralContent, PaperContent

    assert GeneralContent is not None
    assert PaperContent is not None


def test_presentation_pipeline_generator_public_exports() -> None:
    from presentation_pipeline.generator import GenerationConfig, GenerationInput

    assert GenerationConfig is not None
    assert GenerationInput is not None


def test_presentation_pipeline_core_state_exports() -> None:
    from presentation_pipeline.core import create_state, load_state, save_state

    assert create_state is not None
    assert load_state is not None
    assert save_state is not None
