"""Process env loading and FastAPI startup/shutdown hooks."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI

from helpudoc_agent.memory_store import MemoryStoreManager
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
    return {
        "document_inspection": True,
        "knowledge_navigation": True,
    }


def register_app_lifecycle(app: FastAPI, memory_store_manager: MemoryStoreManager) -> None:
    @app.on_event("startup")
    async def _startup() -> None:
        try:
            memory_store_manager.start()
        except Exception:
            logger.exception("Failed to start persistent memory store")
            raise
    @app.on_event("shutdown")
    async def _shutdown() -> None:
        try:
            memory_store_manager.stop()
        except Exception:
            logger.exception("Failed to stop persistent memory store cleanly")
