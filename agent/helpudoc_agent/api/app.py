"""FastAPI application factory for the agent HTTP service."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI

from helpudoc_agent.configuration import describe_workspace_root, load_settings
from helpudoc_agent.memory_store import MemoryStoreManager
from helpudoc_agent.rag_worker import RagIndexWorker
from helpudoc_agent.runtime.agent_registry import AgentRegistry
from helpudoc_agent.tools_and_schemas import GeminiClientManager, ToolFactory
from helpudoc_agent.utils import SourceTracker

from .lifecycle import (
    build_dependency_diagnostic,
    enforce_parser_dependency_policy,
    load_process_env_files,
    register_app_lifecycle,
)
from .paths import HELPUDOC_AGENT_DIR
from .routes.attachments import register_attachments_routes
from .routes.chat import register_chat_routes
from .routes.health import register_health_routes
from .routes.internal import register_internal_routes
from .routes.paper2slides import register_paper2slides_routes
from .routes.rag import register_rag_routes
from .routes.skills import register_skills_routes
from .text_utils import _get_agent_jwt_secret

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    load_process_env_files()
    config_path: Optional[Path] = None
    env_config_path = os.getenv("AGENT_CONFIG_PATH")
    if env_config_path:
        candidate = Path(env_config_path).expanduser()
        if not candidate.is_absolute():
            candidate = (HELPUDOC_AGENT_DIR.parent.parent / candidate).resolve()
        if candidate.exists():
            config_path = candidate
        else:
            logger.warning(
                "AGENT_CONFIG_PATH is set but file does not exist; falling back to built-in config",
                extra={"path": env_config_path},
            )

    settings = load_settings(config_path)
    memory_store_manager = MemoryStoreManager()
    workspace_root_diagnostic = describe_workspace_root(settings)
    workspace_root_message = (
        f"[agent] Workspace root: {workspace_root_diagnostic['resolved_path']} "
        f"(source={workspace_root_diagnostic['source']} "
        f"raw={workspace_root_diagnostic['raw_value'] or '<config>'})"
    )
    print(workspace_root_message)
    logger.info(workspace_root_message)
    file_understanding_mode = (os.getenv("FILE_UNDERSTANDING_MODE", "part-first") or "part-first").strip()
    rag_parser_pipeline = (os.getenv("RAG_PARSER_PIPELINE", "raganything") or "raganything").strip().lower()
    raganything_parser = (os.getenv("RAGANYTHING_PARSER", "docling") or "docling").strip().lower()
    parser_enrichment_mode = (
        os.getenv("PARSER_ENRICHMENT_MODE") or os.getenv("PARSER") or raganything_parser
    ).strip() or raganything_parser
    dependency_diag = build_dependency_diagnostic()
    enforce_parser_dependency_policy(
        file_understanding_mode=file_understanding_mode,
        rag_parser_pipeline=rag_parser_pipeline,
        raganything_parser=raganything_parser,
        parser_enrichment_mode=parser_enrichment_mode,
        dependency_diag=dependency_diag,
    )
    source_tracker = SourceTracker()
    gemini_manager = GeminiClientManager(settings)
    tool_factory = ToolFactory(settings, source_tracker, gemini_manager)
    registry = AgentRegistry(settings, tool_factory, memory_store=memory_store_manager)
    agent_jwt_secret = _get_agent_jwt_secret()

    app = FastAPI(title="DeepAgents Service", version="0.2.0")
    rag_worker = RagIndexWorker(settings.backend.workspace_root)

    register_health_routes(app, dependency_diag)
    register_app_lifecycle(app, memory_store_manager, rag_worker)
    register_internal_routes(
        app,
        settings=settings,
        registry=registry,
        memory_store_manager=memory_store_manager,
        agent_jwt_secret=agent_jwt_secret,
    )
    register_rag_routes(app, rag_worker)
    register_paper2slides_routes(app)
    register_attachments_routes(app, settings=settings, gemini_manager=gemini_manager)
    register_chat_routes(
        app,
        settings=settings,
        memory_store_manager=memory_store_manager,
        registry=registry,
        rag_worker=rag_worker,
        gemini_manager=gemini_manager,
        source_tracker=source_tracker,
        agent_jwt_secret=agent_jwt_secret,
    )
    register_skills_routes(app, settings=settings)

    return app
