"""
RAG Stage - Document indexing and querying
"""
import asyncio
import logging
from pathlib import Path
from typing import Dict, List

from ...utils import save_json
from ..paths import get_rag_checkpoint

logger = logging.getLogger(__name__)


async def run_rag_stage(base_dir: Path, config: Dict) -> Dict:
    """Stage 1: Index document and run RAG queries.
    
    Args:
        base_dir: Base directory for this document/project
        config: Pipeline configuration with input_path (file or directory)
    
    Note:
        RAGClient handles both single files and directories automatically.
        Multiple files will share the same RAG storage for unified content extraction.
    """
    # Get input path from config
    input_path = config.get("input_path")
    if not input_path:
        raise ValueError("Missing input_path in config")
    
    content_type = config.get("content_type", "paper")
    path = Path(input_path)
    
    # Determine storage directory
    output_dir = base_dir / "rag_output"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    from paper2slides.rag import RAGClient, RAG_PAPER_QUERIES, RAG_QUERY_MODES, RAG_AVAILABLE
    from paper2slides.rag.query import get_general_overview, generate_general_queries
    from paper2slides.rag.config import RAGConfig

    # If LightRAG isn't available, create a minimal checkpoint so downstream
    # stages can continue using direct markdown content.
    if not RAG_AVAILABLE:
        logger.warning("LightRAG not available; skipping RAG and creating stub checkpoint.")
        markdown_paths: List[str] = []
        if path.is_file():
            markdown_paths = [str(path)]
        elif path.is_dir():
            markdown_paths = [str(p) for p in path.rglob("*.md")]
        if not markdown_paths:
            raise ValueError("No markdown files found for RAG stub.")

        combined = []
        for md in markdown_paths:
            try:
                combined.append(Path(md).read_text(encoding="utf-8"))
            except Exception:
                continue
        merged = "\n\n".join(combined).strip()
        if not merged:
            raise ValueError("Unable to read markdown content for RAG stub.")

        if content_type == "paper":
            rag_results = {
                "paper_info": [{"answer": merged, "query": "paper info (no RAG)", "mode": "no_rag"}],
                "motivation": [{"answer": merged, "query": "motivation (no RAG)", "mode": "no_rag"}],
                "solution": [{"answer": merged, "query": "solution (no RAG)", "mode": "no_rag"}],
                "results": [{"answer": merged, "query": "results (no RAG)", "mode": "no_rag"}],
                "contributions": [{"answer": merged, "query": "contributions (no RAG)", "mode": "no_rag"}],
            }
        else:
            rag_results = {
                "content": [{"answer": merged, "query": "document content (no RAG)", "mode": "no_rag"}],
            }

        result = {
            "rag_results": rag_results,
            "markdown_paths": markdown_paths,
            "input_path": input_path,
            "content_type": content_type,
            "mode": "no_rag",
        }
        checkpoint_path = get_rag_checkpoint(base_dir, config)
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        save_json(checkpoint_path, result)
        logger.info(f"  Saved stub RAG checkpoint: {checkpoint_path}")
        return result
    
    storage_dir = base_dir / "rag_storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    
    # Create RAGClient with unified storage
    rag_config = RAGConfig.with_paths(
        storage_dir=str(storage_dir),
        output_dir=str(output_dir)
    )
    
    async with RAGClient(config=rag_config) as rag:
        # Index files. RAGClient handles both files and directories
        if path.is_file():
            logger.info(f"Indexing file: {path.name}")
        else:
            logger.info(f"Indexing directory: {path.name}")
        
        batch_result = await rag.index_batch(
            file_paths=[input_path],
            output_dir=str(output_dir),
            recursive=True,
            show_progress=True
        )
        
        logger.info(f"  Indexing completed: {batch_result.get('successful_rag_files', 0)} successful, {batch_result.get('failed_rag_files', 0)} failed")
        
        # Collect markdown paths from parser output
        md_files = list(output_dir.rglob("*.md"))
        markdown_paths = [str(f) for f in md_files]
        
        if markdown_paths:
            logger.info(f"  Found {len(markdown_paths)} markdown file(s)")
        
        logger.info("")
        logger.info(f"Running RAG queries ({content_type})...")
        
        if content_type == "paper":
            rag_results = await rag.batch_query_by_category(
                queries_by_category=RAG_PAPER_QUERIES,
                modes_by_category=RAG_QUERY_MODES,
            )
        else:
            logger.info("  Getting document overview...")
            overview = await get_general_overview(rag, mode="mix")
            logger.info("  Generating queries from overview...")
            queries = generate_general_queries(rag, overview, count=12)
            logger.info(f"  Executing {len(queries)} queries...")
            query_results = await rag.batch_query(queries, mode="mix")
            rag_results = {"content": query_results}
        
        total = sum(len(r) for r in rag_results.values())
        logger.info(f"  Completed {total} queries")
    
    # Save result to mode-specific directory
    result = {
        "rag_results": rag_results,
        "markdown_paths": markdown_paths,
        "input_path": input_path,
        "content_type": content_type,
        "mode": "normal",
    }
    
    # Ensure mode directory exists
    checkpoint_path = get_rag_checkpoint(base_dir, config)
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    
    save_json(checkpoint_path, result)
    logger.info(f"  Saved: {checkpoint_path}")
    return result
