"""Assembles workspace agent tools from configuration."""
from __future__ import annotations

import logging
from importlib import import_module
from typing import Any, Callable, Dict, List

from langchain_core.tools import Tool

from ...bigquery_export_tools import build_export_bigquery_query_tool
from ...configuration import Settings, ToolConfig
from ...state import WorkspaceState
from ...utils import SourceTracker
from .builtins.human_interrupts import (
    build_request_clarification_tool,
    build_request_human_action_tool,
    build_request_plan_approval_tool,
)
from .builtins.a2ui import build_request_ui_tool, build_workflow_action_tool
from .builtins.rag import build_rag_query_tool
from .builtins.skills import (
    build_list_skills_tool,
    build_load_skill_tool,
    build_run_skill_python_script_tool,
)
from .builtins.workspace_files import (
    build_append_to_report_tool,
    build_create_pdf_from_images_tool,
    build_get_image_url_tool,
)
from .gemini_client import GeminiClientManager
from .gemini_image import build_gemini_image_tool
from .web_sources import build_google_search_tool, build_url_context_tool

logger = logging.getLogger(__name__)


class MissingToolBuilderError(RuntimeError):
    """Raised when a configured tool builder cannot be loaded."""


class ToolFactory:
    """Builds tool instances for a given workspace state."""

    def __init__(
        self,
        settings: Settings,
        source_tracker: SourceTracker,
        gemini_manager: GeminiClientManager,
    ):
        self.settings = settings
        self.source_tracker = source_tracker
        self.gemini_manager = gemini_manager
        self._builtin_map: Dict[str, Callable[[WorkspaceState], Tool]] = {
            "google_search": self._build_google_search_tool,
            "url_context": self._build_url_context_tool,
            "gemini_image": self._build_gemini_image_tool,
            "export_bigquery_query": self._build_export_bigquery_query_tool,
            "append_to_report": lambda ws: build_append_to_report_tool(ws),
            "create_pdf_from_images": lambda ws: build_create_pdf_from_images_tool(ws),
            "get_image_url": lambda ws: build_get_image_url_tool(ws),
            "rag_query": lambda ws: build_rag_query_tool(self.settings, ws),
            "list_skills": lambda ws: build_list_skills_tool(self.settings, ws),
            "load_skill": lambda ws: build_load_skill_tool(self.settings, ws),
            "request_plan_approval": lambda ws: build_request_plan_approval_tool(ws),
            "request_clarification": lambda ws: build_request_clarification_tool(ws),
            "request_human_action": lambda ws: build_request_human_action_tool(ws),
            "request_ui": lambda ws: build_request_ui_tool(ws),
            "workflow_action": lambda ws: build_workflow_action_tool(ws),
            "run_skill_python_script": lambda ws: build_run_skill_python_script_tool(self.settings, ws),
        }

    def build_tools(self, tool_names: List[str], workspace_state: WorkspaceState) -> List[Tool]:
        tools: List[Tool] = []
        for name in tool_names:
            config = self.settings.get_tool(name)
            try:
                built = self._build_tool(config, workspace_state)
            except MissingToolBuilderError as exc:
                logger.warning("Skipping unavailable tool '%s': %s", name, exc)
                continue
            if isinstance(built, list):
                tools.extend(built)
            else:
                tools.append(built)
        return tools

    def _build_tool(self, config: ToolConfig, workspace_state: WorkspaceState) -> Tool | List[Tool]:
        if config.name in self._builtin_map:
            return self._builtin_map[config.name](workspace_state)
        if config.entrypoint:
            return self._load_entrypoint(config.entrypoint, workspace_state)
        raise ValueError(f"Tool '{config.name}' has no builder")

    def _load_entrypoint(self, entrypoint: str, workspace_state: WorkspaceState) -> Tool | List[Tool]:
        module_path, attr = entrypoint.split(":")
        try:
            module = import_module(module_path)
        except ModuleNotFoundError as exc:
            if exc.name == module_path or module_path.startswith(f"{exc.name}."):
                raise MissingToolBuilderError(f"module '{module_path}' could not be imported") from exc
            raise
        try:
            factory = getattr(module, attr)
        except AttributeError as exc:
            raise MissingToolBuilderError(
                f"entrypoint '{entrypoint}' is missing attribute '{attr}'"
            ) from exc
        try:
            return factory(workspace_state=workspace_state, source_tracker=self.source_tracker)
        except TypeError:
            return factory()

    def _build_google_search_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_google_search_tool(
            workspace_state=workspace_state,
            source_tracker=self.source_tracker,
            llm=self.gemini_manager.get_search_chat_model(),
            tool_name="google_search",
            tool_description="Use Gemini's built-in search to gather fresh information.",
            search_label="google_search",
        )

    def _build_url_context_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_url_context_tool(
            workspace_state=workspace_state,
            source_tracker=self.source_tracker,
            llm=self.gemini_manager.get_search_chat_model(),
            tool_name="url_context",
            tool_description=(
                "Analyze specific HTTP(S) URLs the user provided using Gemini URL context. "
                "Prefer this when the user pastes explicit links or wants a page summarized; "
                "use google_search for open-ended discovery."
            ),
            label="url_context",
        )

    def _build_gemini_image_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_gemini_image_tool(
            workspace_state=workspace_state,
            client=self.gemini_manager.client,
            model_name=self.gemini_manager.image_model_name,
        )

    def _build_export_bigquery_query_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_export_bigquery_query_tool(workspace_state=workspace_state)
