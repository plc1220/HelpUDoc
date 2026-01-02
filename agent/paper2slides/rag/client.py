"""
RAG Client for Paper2Slides
Document parsing, indexing, and querying for slide/poster generation.
"""

import sys
import asyncio
from pathlib import Path
from typing import Optional, Dict, Any, List, Callable

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

try:  # pragma: no cover - exercised at runtime
    from lightrag.utils import EmbeddingFunc
    _LIGHRAG_AVAILABLE = True
except Exception:  # pragma: no cover - allow optional LightRAG
    _LIGHRAG_AVAILABLE = False

from paper2slides.llm.genai_client import create_client, embed_texts, extract_text, generate_text

from .config import RAGConfig


class RAGClient:
    """
    RAG client for document indexing and querying.
    
    Example:
        async with RAGClient() as rag:
            await rag.index("document.pdf")
            answer = await rag.query("What is the main topic?")
    """
    
    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        lightrag_instance=None,
    ):
        """
        Args:
            config: RAG configuration. Uses defaults if None.
            lightrag_instance: Existing LightRAG instance to reuse.
        """
        self.config = config or RAGConfig()
        self._rag = None
        self._lightrag = lightrag_instance
        self._initialized = False
        self._genai_client = None
        if not _LIGHRAG_AVAILABLE:
            raise ImportError(
                "LightRAG is required for RAG operations but is not installed or incompatible. "
                "Install with `pip install \"lightrag-hku[api]\"` to enable RAG."
            )
    
    @classmethod
    def from_storage(cls, storage_dir: str) -> "RAGClient":
        """Load from existing storage directory."""
        config = RAGConfig.with_paths(storage_dir=storage_dir)
        return cls(config=config)
    
    @classmethod
    def from_lightrag(cls, lightrag_instance, config: Optional[RAGConfig] = None) -> "RAGClient":
        """Wrap an existing LightRAG instance."""
        return cls(config=config, lightrag_instance=lightrag_instance)
    
    def _get_client(self):
        """Get or create a shared GenAI client."""
        if self._genai_client is None:
            api = self.config.api
            self._genai_client = create_client(
                api_key=api.llm_api_key,
                vertexai=api.use_vertexai,
                project=api.project,
                location=api.location,
            )
        return self._genai_client
    
    def _create_llm_func(self) -> Callable:
        api = self.config.api
        client = self._get_client()
        
        async def func(prompt: str, system_prompt: Optional[str] = None,
                       history_messages: List = None, **kwargs):
            messages = history_messages[:] if history_messages else []
            if system_prompt:
                messages.insert(0, {"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})

            response = await asyncio.to_thread(
                generate_text,
                client,
                api.llm_model,
                messages=messages,
                max_output_tokens=kwargs.get("max_tokens"),
                temperature=kwargs.get("temperature"),
            )
            return extract_text(response)
        return func
    
    def _create_vision_func(self) -> Callable:
        api = self.config.api
        client = self._get_client()
        llm_func = self._create_llm_func()
        
        async def func(prompt: str, system_prompt: Optional[str] = None,
                       history_messages: List = None, image_data: Optional[str] = None,
                       messages: Optional[List] = None, **kwargs):
            if messages:
                response = await asyncio.to_thread(
                    generate_text,
                    client,
                    api.llm_model,
                    messages=messages,
                    max_output_tokens=kwargs.get("max_tokens"),
                    temperature=kwargs.get("temperature"),
                )
                return extract_text(response)
            if image_data:
                vision_messages = []
                if system_prompt:
                    vision_messages.append({"role": "system", "content": system_prompt})
                vision_messages.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}},
                        ],
                    }
                )
                response = await asyncio.to_thread(
                    generate_text,
                    client,
                    api.llm_model,
                    messages=vision_messages,
                    max_output_tokens=kwargs.get("max_tokens"),
                    temperature=kwargs.get("temperature"),
                )
                return extract_text(response)
            return await llm_func(prompt, system_prompt, history_messages or [], **kwargs)
        return func
    
    def _create_embedding_func(self) -> EmbeddingFunc:
        api = self.config.api
        client = self._get_client()

        async def _embed(texts: List[str]):
            # google-genai client is synchronous; run in a thread to avoid blocking.
            vectors = await asyncio.to_thread(
                embed_texts,
                client,
                model=api.embedding_model,
                texts=texts,
                output_dimensionality=api.embedding_dim,
            )
            import numpy as np

            return np.array(vectors, dtype=np.float32)

        return EmbeddingFunc(
            embedding_dim=api.embedding_dim,
            max_token_size=api.embedding_max_tokens,
            func=_embed,
        )
    
    def _get_rag(self):
        if self._rag is None:
            from raganything import RAGAnything
            
            rag_config = self.config.to_rag_anything_config()
            
            self._rag = RAGAnything(
                config=rag_config,
                lightrag=self._lightrag,
                llm_model_func=self._create_llm_func(),
                vision_model_func=self._create_vision_func(),
                embedding_func=self._create_embedding_func(),
            )
        return self._rag
    
    async def initialize(self) -> Dict[str, Any]:
        """Initialize the RAG system. Called automatically by context manager."""
        if self._initialized:
            return {"success": True, "message": "Already initialized"}
        
        result = await self._get_rag()._ensure_lightrag_initialized()
        if result.get("success"):
            self._initialized = True
        return result
    
    async def index(
        self,
        file_path: str,
        output_dir: Optional[str] = None,
        parse_method: Optional[str] = None,
        display_stats: Optional[bool] = None,
        split_by_character: Optional[str] = None,
        split_by_character_only: bool = False,
        doc_id: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Parse and index a document.
        
        Args:
            file_path: Path to document (PDF, DOC, etc.)
            output_dir: Directory for parsed outputs. Defaults to config.
            parse_method: 'auto', 'ocr', or 'txt'. Defaults to config.
            display_stats: Whether to display content statistics during parsing.
            split_by_character: Character to split content by (e.g., '\\n\\n').
            split_by_character_only: If True, only use character splitting.
            doc_id: Custom document ID. Auto-generated if None.
            **kwargs: Additional parser parameters (lang, device, start_page, end_page, etc.)
        """
        output = output_dir or self.config.storage.output_dir
        try:
            await self._get_rag().process_document_complete(
                file_path=file_path,
                output_dir=output,
                parse_method=parse_method,
                display_stats=display_stats,
                split_by_character=split_by_character,
                split_by_character_only=split_by_character_only,
                doc_id=doc_id,
                **kwargs,
            )
            return {"success": True, "file": file_path, "output_dir": output}
        except Exception as e:
            return {"success": False, "error": str(e), "file": file_path}
    
    async def index_folder(
        self,
        folder_path: str,
        output_dir: Optional[str] = None,
        parse_method: Optional[str] = None,
        display_stats: Optional[bool] = None,
        split_by_character: Optional[str] = None,
        split_by_character_only: bool = False,
        file_extensions: Optional[List[str]] = None,
        recursive: Optional[bool] = None,
        max_workers: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Index all documents in a folder.
        
        Args:
            folder_path: Path to folder containing documents.
            output_dir: Directory for parsed outputs. Defaults to config.
            parse_method: 'auto', 'ocr', or 'txt'. Defaults to config.
            display_stats: Whether to display content statistics during parsing.
            split_by_character: Character to split content by.
            split_by_character_only: If True, only use character splitting.
            file_extensions: List of file extensions to process (e.g., ['.pdf', '.docx']).
            recursive: Whether to process subfolders. Defaults to config.
            max_workers: Maximum concurrent processing workers. Defaults to config.
        """
        output = output_dir or self.config.storage.output_dir
        await self._get_rag().process_folder_complete(
            folder_path=folder_path,
            output_dir=output,
            parse_method=parse_method,
            display_stats=display_stats,
            split_by_character=split_by_character,
            split_by_character_only=split_by_character_only,
            file_extensions=file_extensions,
            recursive=recursive,
            max_workers=max_workers,
        )
        return {"success": True, "folder": folder_path, "output_dir": output}
    
    async def index_batch(
        self,
        file_paths: List[str],
        output_dir: Optional[str] = None,
        parse_method: Optional[str] = None,
        max_workers: Optional[int] = None,
        recursive: Optional[bool] = None,
        show_progress: bool = True,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Index multiple documents by file paths.
        
        Args:
            file_paths: List of file paths to process.
            output_dir: Directory for parsed outputs. Defaults to config.
            parse_method: 'auto', 'ocr', or 'txt'. Defaults to config.
            max_workers: Maximum concurrent processing workers. Defaults to config.
            recursive: Whether to process subfolders (if paths include folders).
            show_progress: Whether to show progress bar.
            **kwargs: Additional parser parameters.
        """
        output = output_dir or self.config.storage.output_dir
        return await self._get_rag().process_documents_with_rag_batch(
            file_paths=file_paths,
            output_dir=output,
            parse_method=parse_method,
            max_workers=max_workers,
            recursive=recursive,
            show_progress=show_progress,
            **kwargs,
        )
    
    async def query(
        self,
        question: str,
        mode: str = "mix",
        system_prompt: Optional[str] = None,
        vlm_enhanced: Optional[bool] = None,
        **kwargs,
    ) -> str:
        """
        Query the paper content.
        
        Args:
            question: Question about the paper.
            mode: Query mode - "local", "global", "hybrid", "naive", "mix", "bypass".
                  Default is "mix" (recommended).
            system_prompt: Optional system prompt to include.
            vlm_enhanced: If True, parse image paths in retrieved context and replace
                         with base64 encoded images for VLM processing.
                         Default: True when vision_model_func is available.
            **kwargs: Other query parameters passed to QueryParam
                     (top_k, max_tokens, temperature, etc.)
        """
        if not self._initialized:
            await self.initialize()
        
        return await self._get_rag().aquery(
            question,
            mode=mode,
            system_prompt=system_prompt,
            vlm_enhanced=vlm_enhanced,
            **kwargs,
        )
    
    async def batch_query(
        self,
        questions: List[str],
        mode: str = "mix",
        system_prompt: Optional[str] = None,
        max_concurrency: int = 8,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Query multiple questions with sliding window concurrency.
        
        Args:
            questions: List of questions to query.
            mode: Query mode for all questions.
            system_prompt: Optional system prompt for all queries.
            max_concurrency: Maximum number of concurrent queries (default 5).
                            When one query finishes, the next one starts immediately.
            **kwargs: Other query parameters.
        """
        semaphore = asyncio.Semaphore(max_concurrency)
        
        async def query_one(idx: int, q: str) -> tuple:
            """Execute a single query with semaphore control."""
            async with semaphore:
                try:
                    answer = await self.query(q, mode=mode, system_prompt=system_prompt, **kwargs)
                    return (idx, {"query": q, "answer": answer, "mode": mode, "success": True})
                except Exception as e:
                    return (idx, {"query": q, "answer": None, "mode": mode, "success": False, "error": str(e)})
        
        # Create all tasks at once - semaphore controls actual concurrency
        tasks = [query_one(i, q) for i, q in enumerate(questions)]
        results_with_idx = await asyncio.gather(*tasks)
        
        # Sort by original index to maintain order
        results_with_idx.sort(key=lambda x: x[0])
        return [r for _, r in results_with_idx]

    async def batch_query_by_category(
        self,
        queries_by_category: Dict[str, List[str]],
        modes_by_category: Optional[Dict[str, str]] = None,
        default_mode: str = "mix",
        max_concurrency: int = 8,
        **kwargs,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Execute batch queries organized by category with sliding window concurrency.
        
        All queries across all categories are executed concurrently (up to max_concurrency).
        When one query finishes, the next one starts immediately regardless of category.
        
        Args:
            queries_by_category: Queries organized by category {category: [queries]}
            modes_by_category: Optional mode override for each category {category: mode}
            default_mode: Default query mode when category not specified in modes_by_category
            max_concurrency: Maximum number of concurrent queries (default 5).
            **kwargs: Additional query parameters
        """
        semaphore = asyncio.Semaphore(max_concurrency)
        
        async def query_one(category: str, idx: int, q: str, mode: str) -> tuple:
            """Execute a single query with semaphore control."""
            async with semaphore:
                try:
                    answer = await self.query(q, mode=mode, **kwargs)
                    return (category, idx, {"query": q, "answer": answer, "mode": mode, "success": True})
                except Exception as e:
                    return (category, idx, {"query": q, "answer": None, "mode": mode, "success": False, "error": str(e)})
        
        # Flatten all queries into a single list of tasks
        tasks = []
        for category, queries in queries_by_category.items():
            category_mode = (modes_by_category or {}).get(category, default_mode)
            for idx, q in enumerate(queries):
                tasks.append(query_one(category, idx, q, category_mode))
        
        # Execute all tasks concurrently with semaphore limiting actual concurrency
        all_results = await asyncio.gather(*tasks)
        
        # Group results back by category and restore order
        results_by_category: Dict[str, List] = {cat: [] for cat in queries_by_category.keys()}
        for category, idx, result in all_results:
            results_by_category[category].append((idx, result))
        
        # Sort each category's results by original index
        for category in results_by_category:
            results_by_category[category].sort(key=lambda x: x[0])
            results_by_category[category] = [r for _, r in results_by_category[category]]
        
        return results_by_category

    def get_supported_extensions(self) -> List[str]:
        """Get supported file extensions."""
        return self._get_rag().get_supported_file_extensions()
    
    def get_config_info(self) -> Dict[str, Any]:
        """Get current configuration information."""
        return self._get_rag().get_config_info()
    
    def get_processor_info(self) -> Dict[str, Any]:
        """Get processor information."""
        return self._get_rag().get_processor_info()
    
    def update_config(self, **kwargs):
        """Update RAG configuration with new values."""
        self._get_rag().update_config(**kwargs)
    
    def update_context_config(self, **context_kwargs):
        """
        Update context extraction configuration.
        
        Args:
            **context_kwargs: Context configuration parameters
                (context_window, context_mode, max_context_tokens, etc.)
        """
        self._get_rag().update_context_config(**context_kwargs)
    
    def set_content_source_for_context(self, content_source, content_format: str = "auto"):
        """
        Set content source for context extraction in all modal processors.
        
        Args:
            content_source: Source content for context extraction.
            content_format: Format of content source ("minerU", "text_chunks", "auto").
        """
        self._get_rag().set_content_source_for_context(content_source, content_format)
    
    async def close(self):
        """Release resources."""
        if self._rag is not None:
            await self._rag.finalize_storages()
            self._rag = None
            self._initialized = False
    
    async def __aenter__(self):
        await self.initialize()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()
