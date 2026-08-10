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
    from helpudoc_agent.tools.workspace.office.config import OfficeRunnerConfig
    from helpudoc_agent.tools.workspace.office.runner import (
        get_binary_sha256,
        get_officecli_version,
        is_binary_ready,
    )

    office_config = OfficeRunnerConfig()
    office_ready = is_binary_ready(office_config)
    return {
        "document_inspection": True,
        "knowledge_navigation": True,
        "officecli": {
            "ready": office_ready,
            "version": get_officecli_version(office_config),
            "binary_sha256": get_binary_sha256(office_config),
        },
    }


def register_app_lifecycle(
    app: FastAPI,
    memory_store_manager: MemoryStoreManager,
    *,
    workspace_root: Any = None,
) -> None:
    @app.on_event("startup")
    async def _startup() -> None:
        from helpudoc_agent.sandbox_runner import cleanup_stale_inline_run_dirs_under_root

        cleanup_stale_inline_run_dirs_under_root(workspace_root)
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
