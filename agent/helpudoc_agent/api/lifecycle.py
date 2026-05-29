"""Process env loading and FastAPI startup/shutdown hooks."""
from __future__ import annotations

import importlib
import logging
import os
import sys
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI

from helpudoc_agent.memory_store import MemoryStoreManager
from helpudoc_agent.rag_worker import RagIndexWorker

from .attachment_processing import _docling_available
from .paths import AGENT_PROJECT_ROOT

logger = logging.getLogger(__name__)


def load_process_env_files() -> None:
    """Load environment variables from known locations.

    We prioritize the agent's .env (agent/.env) and then allow any existing
    process-level env vars to remain.
    """
    env_file = os.getenv("ENV_FILE")
    if env_file:
        load_dotenv(env_file)
        return
    load_dotenv(AGENT_PROJECT_ROOT / ".env")


def build_dependency_diagnostic() -> Dict[str, Any]:
    dependency_diag: Dict[str, Any] = {
        "lightrag": True,
        "raganything": True,
        "docling": _docling_available(),
    }
    try:
        importlib.import_module("lightrag")
    except Exception:
        dependency_diag["lightrag"] = False
    try:
        importlib.import_module("raganything")
    except Exception:
        try:
            importlib.import_module("document_intelligence.raganything")
        except Exception:
            dependency_diag["raganything"] = False
    return dependency_diag


def enforce_parser_dependency_policy(
    *,
    file_understanding_mode: str,
    rag_parser_pipeline: str,
    raganything_parser: str,
    parser_enrichment_mode: str,
    dependency_diag: Dict[str, Any],
) -> None:
    logger.info(
        "[agent] File understanding: mode=%s parserPipeline=%s ragParser=%s parserEnrichment=%s deps=%s python=%s",
        file_understanding_mode,
        rag_parser_pipeline,
        raganything_parser,
        parser_enrichment_mode,
        dependency_diag,
        sys.executable,
    )
    if rag_parser_pipeline in {"raganything", "rag_anything", "rag-everything", "rageverything"} and raganything_parser == "docling":
        if not dependency_diag["docling"]:
            raise RuntimeError(
                "Docling is configured as the global parser, but the docling package/CLI is unavailable. "
                "Install docling and ensure the `docling` command is on PATH."
            )


def register_app_lifecycle(app: FastAPI, memory_store_manager: MemoryStoreManager, rag_worker: RagIndexWorker) -> None:
    @app.on_event("startup")
    async def _startup() -> None:
        try:
            memory_store_manager.start()
        except Exception:
            logger.exception("Failed to start persistent memory store")
            raise
        try:
            await rag_worker.start()
        except Exception:
            logger.exception("Failed to start RAG index worker (continuing without it)")

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        try:
            await rag_worker.stop()
        except Exception:
            logger.exception("Failed to stop RAG index worker cleanly")
        try:
            memory_store_manager.stop()
        except Exception:
            logger.exception("Failed to stop persistent memory store cleanly")
